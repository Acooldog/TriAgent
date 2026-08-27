/** workerEventRegistry — Agent 事件注册表 + dispatcher。
 *
 * OCP 修复：switch-case 已迁移至事件注册表。
 * 新增事件类型只需通过 registerEventHandler 注册。
 *
 * DIP 修复：处理器逻辑拆分到 workerLifecycleHandlers /
 * workerToolHandlers / workerMessageHandlers 三个域文件。
 */
import type {
  ProgressDeps,
  WorkerEventDeps,
} from "./workerEventDeps";
import { handleBatchEvent } from "./batchEventHandlers";
import {
  handleAgentError,
  handleAgentFinished,
  handleAgentLog,
  handleAgentReady,
  handleAgentStarted,
  handleAgentWarning,
  handleWorkerFinished,
} from "./workerLifecycleHandlers";
import {
  handleAgentMessage,
  handleAgentQuestion,
} from "./workerMessageHandlers";
import {
  handleAgentStepFailed,
  handleAgentStepFinished,
  handleAgentToolCall,
} from "./workerToolHandlers";

/** 事件处理器函数签名。 */
export type EventHandler = (
  deps: WorkerEventDeps,
  payload: Record<string, unknown>,
  status: string,
  event: Record<string, unknown>,
) => void;

/** batch_/file_ 前缀事件 — 委托给 batchEventHandlers。 */
function handleBatchPrefix(
  deps: ProgressDeps,
  eventType: string,
  payload: Record<string, unknown>,
): void {
  handleBatchEvent(eventType, payload, { setBatchProgress: deps.setBatchProgress });
}

/**
 * 事件注册表 — 事件类型到处理器的映射。
 *
 * OCP：新增事件类型只需在此 Map 中注册，无需修改 dispatcher。
 * DIP：每个处理器通过依赖注入获得所需的最小接口。
 */
const eventRegistry = new Map<string, EventHandler>([
  ["agent_log", (d, p) => handleAgentLog(d, p)],
  ["agent_started", (d, _p, _s, e) => handleAgentStarted(d, _p, e)],
  ["agent_ready", (d, p) => handleAgentReady(d, p)],
  ["agent_tool_call", (d, p) => handleAgentToolCall(d, p)],
  ["agent_step_finished", (d, p) => handleAgentStepFinished(d, p)],
  ["agent_step_failed", (d, p) => handleAgentStepFailed(d, p)],
  ["agent_message", (d, p) => handleAgentMessage(d, p)],
  ["agent_question", (d, p) => handleAgentQuestion(d, p)],
  ["agent_finished", (d, _p, _s, e) => handleAgentFinished(d, _p, e)],
  ["agent_error", (d, p) => handleAgentError(d, p)],
  ["agent_warning", (d, p) => handleAgentWarning(d, p)],
  ["worker_finished", (d) => handleWorkerFinished(d)],
]);

/**
 * 查找并执行事件处理器。
 *
 * 优先匹配注册表；未注册的事件委托给 batch/file 前缀处理器。
 */
export function dispatchWorkerEvent(args: {
  deps: WorkerEventDeps;
  eventType: string;
  payload: Record<string, unknown>;
  status: string;
  event: Record<string, unknown>;
}): void {
  const { deps, eventType, payload, status, event } = args;

  const handler = eventRegistry.get(eventType);
  if (handler) {
    handler(deps, payload, status, event);
    return;
  }

  // 未注册事件 — 检查 batch_/file_ 前缀
  if (eventType.startsWith("batch_") || eventType.startsWith("file_")) {
    handleBatchPrefix(deps, eventType, payload);
  }
}

/** 注册新的事件处理器（OCP 扩展点）。 */
export function registerEventHandler(
  eventType: string,
  handler: EventHandler,
): void {
  eventRegistry.set(eventType, handler);
}

/** 获取当前已注册的事件类型列表。 */
export function getRegisteredEventTypes(): string[] {
  return Array.from(eventRegistry.keys());
}
