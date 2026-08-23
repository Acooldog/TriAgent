import { randomUUID } from "node:crypto";
import type { ArtifactReference, SessionEventRecord, SessionPersistenceService, SessionTaskState } from "./sessionPersistence";
import type { SessionInfo } from "./workspaceService";
import { ProviderContractError, normalizeProviderError, sanitizeProviderData, validateArtifacts, validateProviderEvent, validateProviderOutput, type ProviderCall, type ProviderCapabilityManifest, type ProviderEvent, type ProviderGateway, type ProviderHealth, type ProviderInvocationRequest, type ProviderRegistration } from "./providerProtocol";
import type { ProviderRegistry } from "./providerRegistry";

export interface ProviderSessionContext { root: string; session: SessionInfo; }
export interface ProviderCallHandle { requestId: string; taskId: string; completion: Promise<{ requestId: string; taskId: string; output: unknown }>; }

interface ActiveProviderCall {
  request: ProviderInvocationRequest;
  capability: ProviderCapabilityManifest;
  controller: AbortController;
  cancellation: Promise<void>;
  resolveCancellation: () => void;
  cancelled: boolean;
}

export class ProviderService {
  private readonly active = new Map<string, ActiveProviderCall>();

  public constructor(
    private readonly registry: ProviderRegistry,
    private readonly gateway: ProviderGateway,
    private readonly persistence?: SessionPersistenceService,
    private readonly onSessionChanged: (context: ProviderSessionContext) => Promise<void> = async () => undefined,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
  ) {}

  public list(): ProviderRegistration[] { return this.registry.list(); }

  public setEnabled(providerId: string, enabled: boolean): ProviderRegistration {
    return this.registry.setEnabled(providerId, enabled);
  }

  public async refresh(): Promise<ProviderRegistration[]> {
    let manifests;
    try { manifests = await this.gateway.discover(); } catch (error) { throw normalizeProviderError(error); }
    this.registry.refresh(manifests);
    for (const registration of this.registry.list()) if (registration.enabled) await this.checkHealth(registration.manifest.provider_id);
    return this.registry.list();
  }

  public async checkHealth(providerId: string): Promise<ProviderRegistration> {
    try {
      const health = await this.gateway.checkHealth(providerId);
      return this.registry.setHealth(providerId, normalizeHealth(health, this.now));
    } catch (error) {
      const normalized = normalizeProviderError(error);
      return this.registry.setHealth(providerId, { status: "unhealthy", checkedAt: this.now().toISOString(), message: normalized.message });
    }
  }

  public start(call: ProviderCall, context?: ProviderSessionContext, onEvent: (event: ProviderEvent) => void = () => undefined): ProviderCallHandle {
    const { capability } = this.registry.resolve(call);
    const request: ProviderInvocationRequest = { ...call, requestId: this.createId(), taskId: this.createId(), timeoutMs: capability.timeout_ms };
    const controller = new AbortController();
    let resolveCancellation!: () => void;
    const cancellation = new Promise<void>((resolve) => { resolveCancellation = resolve; });
    const active: ActiveProviderCall = { request, capability, controller, cancellation, resolveCancellation, cancelled: false };
    this.active.set(request.taskId, active);
    return { requestId: request.requestId, taskId: request.taskId, completion: this.execute(active, context, onEvent) };
  }

  public invoke(call: ProviderCall, context?: ProviderSessionContext, onEvent: (event: ProviderEvent) => void = () => undefined): Promise<{ requestId: string; taskId: string; output: unknown }> {
    return this.start(call, context, onEvent).completion;
  }

  private async execute(active: ActiveProviderCall, context: ProviderSessionContext | undefined, onEvent: (event: ProviderEvent) => void): Promise<{ requestId: string; taskId: string; output: unknown }> {
    const { request, capability, controller } = active;
    let lastSequence = -1;
    let eventQueue = Promise.resolve();
    let acceptingEvents = true;
    let terminalEventSeen = false;
    let rejectTerminalEvent!: (error: ProviderContractError) => void;
    const terminalEventFailure = new Promise<never>((_resolve, reject) => { rejectTerminalEvent = reject; });
    let taskStarted = false;
    const acceptEvent = (event: ProviderEvent): void => {
      if (!acceptingEvents) return;
      if (terminalEventSeen) throw new ProviderContractError("provider-event-after-terminal", "Provider 终态后不能继续发送事件。");
      validateProviderEvent(event, request, capability);
      if (event.sequence <= lastSequence) throw new ProviderContractError("provider-event-order", "Provider 事件顺序无效。");
      lastSequence = event.sequence;
      const sanitized = sanitizeEvent(event);
      terminalEventSeen = sanitized.status === "completed" || sanitized.status === "failed" || sanitized.status === "cancelled";
      eventQueue = eventQueue.then(async () => { await this.persistProviderEvent(context, sanitized); onEvent(sanitized); });
      if (sanitized.status === "failed" || sanitized.status === "cancelled") {
        rejectTerminalEvent(new ProviderContractError(sanitized.status === "cancelled" ? "provider-cancelled" : sanitized.error?.code || "provider-execution-failed", sanitized.error?.message || (sanitized.status === "cancelled" ? "Provider 调用已取消。" : "Provider 执行失败。")));
      }
    };

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await this.persistTask(context, request, "running");
      taskStarted = true;
      await this.persistLifecycle(context, request, "provider_call_started", "running", { providerId: request.providerId, capabilityId: request.capabilityId });
      if (active.cancelled) throw new ProviderContractError("provider-cancelled", "Provider 调用已取消。");
      const timeoutFailure = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          if (capability.cancellation) void this.gateway.cancel(request.providerId, request.taskId).catch(() => false);
          reject(new ProviderContractError("provider-timeout", "Provider 调用超时。"));
        }, request.timeoutMs);
      });
      const cancellationFailure = active.cancellation.then<never>(() => { throw new ProviderContractError("provider-cancelled", "Provider 调用已取消。"); });
      const result = await Promise.race([this.gateway.invoke(request, acceptEvent, controller.signal), timeoutFailure, cancellationFailure, terminalEventFailure]);
      acceptingEvents = false;
      await eventQueue;
      validateProviderOutput(capability, result.output);
      if (result.artifacts) { validateArtifacts(result.artifacts); await this.persistArtifacts(context, result.artifacts); }
      const output = sanitizeProviderData(result.output);
      await this.persistTask(context, request, "completed", undefined, { output });
      await this.persistLifecycle(context, request, "provider_call_completed", "completed", { output });
      return { requestId: request.requestId, taskId: request.taskId, output };
    } catch (error) {
      acceptingEvents = false;
      controller.abort();
      await eventQueue.catch(() => undefined);
      const normalized = normalizeProviderError(error);
      const status = normalized.code === "provider-cancelled" || normalized.code === "provider-timeout" ? "stopped" : "failed";
      if (taskStarted) {
        await this.persistTask(context, request, status, normalized);
        await this.persistLifecycle(context, request, "provider_call_failed", status, { error: { code: normalized.code, message: normalized.message } });
      }
      throw normalized;
    } finally {
      acceptingEvents = false;
      if (timeout) clearTimeout(timeout);
      this.active.delete(request.taskId);
    }
  }

  public async cancel(taskId: string): Promise<boolean> {
    const active = this.active.get(taskId);
    if (!active) return false;
    if (!active.capability.cancellation) throw new ProviderContractError("provider-cancellation-unsupported", "此 Provider 能力不支持取消。");
    active.cancelled = true;
    active.controller.abort();
    active.resolveCancellation();
    void this.gateway.cancel(active.request.providerId, taskId).catch(() => false);
    return true;
  }

  private async persistTask(context: ProviderSessionContext | undefined, request: ProviderInvocationRequest, status: SessionTaskState["status"], error?: ProviderContractError, result?: Record<string, unknown>): Promise<void> {
    if (!context || !this.persistence) return;
    const now = this.now().toISOString();
    const existing = (await this.persistence.load(context.root, context.session)).tasks.find((task) => task.taskId === request.taskId);
    await this.persistence.updateTask(context.root, context.session, { taskId: request.taskId, kind: "provider", providerId: request.providerId, capabilityId: request.capabilityId, requestId: request.requestId, status, startedAt: existing?.startedAt ?? now, updatedAt: now, ...(status !== "running" ? { completedAt: now } : {}), ...(error ? { error: { code: error.code, message: error.message } } : {}), ...(result ? { result } : {}) });
    await this.onSessionChanged(context);
  }

  private async persistProviderEvent(context: ProviderSessionContext | undefined, event: ProviderEvent): Promise<void> {
    if (!context || !this.persistence) return;
    const payload = sanitizeRecord({ providerId: event.provider_id, capabilityId: event.capability_id, sequence: event.sequence, payload: event.payload, error: event.error });
    await this.persistence.recordEvent(context.root, context.session, { eventId: this.createId(), emittedAt: event.emitted_at, category: "provider", eventType: event.event_type, status: event.status, taskId: event.task_id, requestId: event.request_id, payload, collapsed: true });
    await this.persistence.recordLog(context.root, context.session, { emittedAt: event.emitted_at, level: event.status === "failed" ? "error" : "info", message: event.event_type, context: { providerId: event.provider_id, capabilityId: event.capability_id, taskId: event.task_id } });
    if (event.artifacts) await this.persistArtifacts(context, event.artifacts);
    await this.onSessionChanged(context);
  }

  private async persistLifecycle(context: ProviderSessionContext | undefined, request: ProviderInvocationRequest, eventType: string, status: string, payload: Record<string, unknown>): Promise<void> {
    if (!context || !this.persistence) return;
    const emittedAt = this.now().toISOString();
    const event: SessionEventRecord = { eventId: this.createId(), emittedAt, category: "provider", eventType, status, taskId: request.taskId, requestId: request.requestId, payload: sanitizeRecord(payload), collapsed: true };
    await this.persistence.recordEvent(context.root, context.session, event);
    await this.persistence.recordLog(context.root, context.session, { emittedAt, level: status === "failed" ? "error" : "info", message: eventType, context: { providerId: request.providerId, capabilityId: request.capabilityId, taskId: request.taskId } });
    await this.onSessionChanged(context);
  }

  private async persistArtifacts(context: ProviderSessionContext | undefined, artifacts: import("./providerProtocol").ProviderArtifact[]): Promise<void> {
    if (!context || !this.persistence) return;
    for (const artifact of artifacts) {
      const reference: ArtifactReference = { artifactId: artifact.artifact_id, relativePath: artifact.relative_path, kind: artifact.kind, createdAt: this.now().toISOString(), ...(artifact.metadata ? { metadata: sanitizeRecord(artifact.metadata) } : {}) };
      await this.persistence.recordArtifact(context.root, context.session, reference);
    }
  }
}

function normalizeHealth(health: ProviderHealth, now: () => Date): ProviderHealth {
  if (health.status !== "healthy" && health.status !== "unhealthy") throw new ProviderContractError("provider-health-invalid", "Provider 健康检查结果无效。");
  return { status: health.status, checkedAt: health.checkedAt || now().toISOString(), ...(health.message ? { message: String(sanitizeProviderData(health.message)) } : {}) };
}

function sanitizeEvent(event: ProviderEvent): ProviderEvent {
  return { ...event, payload: sanitizeRecord(event.payload), ...(event.error ? { error: { ...event.error, message: String(sanitizeProviderData(event.error.message)) } } : {}), ...(event.artifacts ? { artifacts: event.artifacts.map((artifact) => ({ ...artifact, ...(artifact.metadata ? { metadata: sanitizeRecord(artifact.metadata) } : {}) })) } : {}) };
}

function sanitizeRecord(value: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizeProviderData(value);
  return typeof sanitized === "object" && sanitized !== null && !Array.isArray(sanitized) ? sanitized as Record<string, unknown> : {};
}
