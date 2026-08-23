import { randomUUID } from "node:crypto";
import type { PermissionMode } from "./toolProtocol";
import type { ProviderEvent } from "./providerProtocol";
import type { ProviderRuntimeService } from "./providerRuntimeService";
import type { ProviderService, ProviderSessionContext } from "./providerService";
import type { SessionPersistenceService } from "./sessionPersistence";
import type { PermissionPolicy } from "./permissionPolicy";

export interface AgentPlanStep {
  stepId: string;
  title: string;
  providerId: string;
  capabilityId: string;
  input: Record<string, unknown>;
  approvalRequired: boolean;
}

export interface AgentPlan {
  taskId: string;
  prompt: string;
  summary: string;
  steps: AgentPlanStep[];
}

export interface AgentEvent {
  taskId: string;
  type: "plan_created" | "approval_required" | "runtime_started" | "provider_event" | "completed" | "failed" | "cancelled";
  status: "running" | "completed" | "failed" | "cancelled";
  payload: Record<string, unknown>;
  emittedAt: string;
}

export interface AgentTaskHandle {
  taskId: string;
  plan: AgentPlan;
  completion: Promise<{ taskId: string; output: unknown }>;
}

export const MVP_PROVIDER_ID = "mvp.local.decrypt";
export const MVP_CAPABILITY_ID = "music.decrypt";

export class AgentTaskService {
  private readonly active = new Map<string, { providerTaskId?: string; providerId: string; context?: ProviderSessionContext }>();

  public constructor(
    private readonly runtime: ProviderRuntimeService,
    private readonly providers: ProviderService,
    private readonly permissions: PermissionPolicy,
    private readonly persistence?: SessionPersistenceService,
    private readonly onSessionChanged: (context: ProviderSessionContext) => Promise<void> = async () => undefined,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
  ) {}

  public createPlan(prompt: string): AgentPlan {
    const normalized = prompt.trim();
    if (!normalized) throw new Error("任务内容不能为空。");
    const inputPath = extractPath(normalized, "输入") ?? extractPath(normalized, "源文件") ?? extractFirstPath(normalized);
    const outputDir = extractPath(normalized, "输出") ?? extractPath(normalized, "目标") ?? "output";
    if (!inputPath) throw new Error("请在任务中提供输入文件路径，例如：输入 D:\\Music\\sample.kgg，输出 D:\\Music\\decoded。");
    const taskId = this.createId();
    return {
      taskId,
      prompt: normalized,
      summary: `解密本地文件：${basename(inputPath)}`,
      steps: [{ stepId: `${taskId}-decrypt`, title: "调用本地解密能力", providerId: MVP_PROVIDER_ID, capabilityId: MVP_CAPABILITY_ID, input: { platform: "kugou", inputPath, outputDir, recursive: false }, approvalRequired: true }],
    };
  }

  public start(prompt: string, permissionMode: PermissionMode, context?: ProviderSessionContext, onEvent: (event: AgentEvent) => void = () => undefined): AgentTaskHandle {
    const plan = this.createPlan(prompt);
    const emit = (type: AgentEvent["type"], status: AgentEvent["status"], payload: Record<string, unknown> = {}) => {
      const event: AgentEvent = { taskId: plan.taskId, type, status, payload, emittedAt: this.now().toISOString() };
      onEvent(event);
      if (context && this.persistence) void this.persistence.recordEvent(context.root, context.session, { eventId: this.createId(), emittedAt: event.emittedAt, category: "task", eventType: `agent_${type}`, status, taskId: plan.taskId, payload });
      if (context && this.persistence) void this.persistence.recordLog(context.root, context.session, { emittedAt: event.emittedAt, level: status === "failed" ? "error" : "info", message: `agent_${type}`, context: { taskId: plan.taskId } });
    };
    const step = plan.steps[0]!;
    emit("plan_created", "running", { summary: plan.summary, steps: plan.steps.map(({ stepId, title, providerId, capabilityId, approvalRequired }) => ({ stepId, title, providerId, capabilityId, approvalRequired })) });
    if (context && this.persistence) {
      void this.persistence.appendMessage(context.root, context.session, { role: "user", content: prompt });
      void this.persistence.appendMessage(context.root, context.session, { role: "assistant", content: JSON.stringify({ type: "agent_plan", plan }) });
    }
    const completion = this.execute(plan, step, permissionMode, context, emit);
    return { taskId: plan.taskId, plan, completion };
  }

  public async cancel(taskId: string): Promise<boolean> {
    const active = this.active.get(taskId);
    if (!active) return false;
    if (active.providerTaskId) return this.providers.cancel(active.providerTaskId);
    return this.runtime.cancel(active.providerId);
  }

  private async execute(plan: AgentPlan, step: AgentPlanStep, permissionMode: PermissionMode, context: ProviderSessionContext | undefined, emit: (type: AgentEvent["type"], status: AgentEvent["status"], payload?: Record<string, unknown>) => void): Promise<{ taskId: string; output: unknown }> {
    this.active.set(plan.taskId, { providerId: step.providerId, context });
    try {
      emit("approval_required", "running", { title: "解密任务审批", detail: "任务将启动本地 Provider 并写入输出文件。" });
      await this.permissions.authorize({ mode: permissionMode, operation: "provider", title: "解密任务审批", detail: "任务将启动本地 Provider 并写入输出文件。" });
      const runtime = await this.runtime.start({ providerId: step.providerId, permissionMode }, context);
      emit("runtime_started", "running", { status: runtime.status });
      const handle = this.providers.start({ providerId: step.providerId, capabilityId: step.capabilityId, input: step.input, permissionMode }, context, (event: ProviderEvent) => emit("provider_event", event.status, { event }));
      this.active.set(plan.taskId, { providerTaskId: handle.taskId, providerId: step.providerId, context });
      const result = await handle.completion;
      emit("completed", "completed", { output: result.output });
      if (context) await this.onSessionChanged(context);
      return { taskId: plan.taskId, output: result.output };
    } catch (error) {
      const message = error instanceof Error ? error.message : "解密任务失败。";
      const cancelled = /取消|cancel/i.test(message);
      emit(cancelled ? "cancelled" : "failed", cancelled ? "cancelled" : "failed", { message });
      throw error;
    } finally { this.active.delete(plan.taskId); }
  }
}

function extractPath(text: string, label: string): string | undefined {
  const match = text.match(new RegExp(`${label}\\s*[:：]?\\s*(?:路径\\s*)?([^，,;；\\n]+)`, "i"));
  return match?.[1]?.trim().replace(/[。.!！]+$/, "") || undefined;
}
function extractFirstPath(text: string): string | undefined { return text.match(/[A-Za-z]:\\[^，,;；\\n ]+/)?.[0]; }
function basename(value: string): string { return value.split(/[\\/]/).pop() || value; }
