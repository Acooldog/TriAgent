import { randomUUID } from "node:crypto";
import type { SessionPersistenceService, SessionTaskState } from "./sessionPersistence";
import { ProviderRuntimeStartPolicy } from "./providerRuntimePolicy";
import { normalizeProviderRuntimeError, ProviderRuntimeError, sanitizeRuntimePayload, validateRuntimeDescriptor, DEFAULT_PROVIDER_RUNTIME_TIMEOUTS, type ProviderRuntimeDescriptor, type ProviderRuntimeEvent, type ProviderRuntimeExit, type ProviderRuntimeGateway, type ProviderRuntimeInstance, type ProviderRuntimeStartRequest, type ProviderRuntimeState, type ProviderRuntimeStatus, type ProviderRuntimeTimeouts } from "./providerRuntimeProtocol";
import { validateProviderManifest } from "./providerProtocol";
import type { ProviderRegistry } from "./providerRegistry";
import type { ProviderSessionContext } from "./providerService";

interface RuntimeOperation { kind: "start" | "stop" | "health" | "recover"; controller: AbortController; promise: Promise<ProviderRuntimeState>; }

export class ProviderRuntimeService {
  private readonly descriptors = new Map<string, ProviderRuntimeDescriptor>();
  private readonly states = new Map<string, ProviderRuntimeState>();
  private readonly instances = new Map<string, ProviderRuntimeInstance>();
  private readonly operations = new Map<string, RuntimeOperation>();
  private readonly generations = new Map<string, number>();
  private readonly sequences = new Map<string, number>();
  private readonly contexts = new Map<string, ProviderSessionContext>();
  private readonly runTimers = new Map<string, ReturnType<typeof setTimeout>>();

  public constructor(
    private readonly gateway: ProviderRuntimeGateway,
    private readonly registry: ProviderRegistry,
    private readonly policy: ProviderRuntimeStartPolicy,
    private readonly persistence?: SessionPersistenceService,
    private readonly onSessionChanged: (context: ProviderSessionContext) => Promise<void> = async () => undefined,
    private readonly onProviderUnavailable: (providerId: string, error: ProviderRuntimeError) => void | Promise<void> = () => undefined,
    private readonly publishEvent: (event: ProviderRuntimeEvent) => void = () => undefined,
    private readonly timeouts: ProviderRuntimeTimeouts = DEFAULT_PROVIDER_RUNTIME_TIMEOUTS,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
  ) { this.gateway.onExit((event) => { void this.handleExit(event); }); }

  public list(): ProviderRuntimeState[] {
    if (this.states.size === 0) return [{ providerId: null, displayName: "能力 Provider", status: "unconfigured", message: "当前未配置能力 Provider。", recoverySuggestion: "请安装或配置受支持的 Provider 后刷新。", updatedAt: this.now().toISOString() }];
    return [...this.states.values()].map((state) => structuredClone(state));
  }

  public async initialize(context?: ProviderSessionContext): Promise<ProviderRuntimeState[]> {
    await this.discover(context);
    const recovered = await this.withTimeout("recover", this.timeouts.operationMs, (signal) => this.gateway.recover(signal)).catch(() => []);
    for (const instance of recovered) if (this.descriptors.has(instance.providerId)) await this.recoverInstance(instance, context).catch(() => undefined);
    return this.list();
  }

  public async discover(context?: ProviderSessionContext): Promise<ProviderRuntimeState[]> {
    const operationId = this.createId();
    try {
      const descriptors = await this.withTimeout("discover", this.timeouts.discoveryMs, (signal) => this.gateway.discover(signal));
      const incoming = new Map<string, ProviderRuntimeDescriptor>();
      for (const descriptor of descriptors) { validateRuntimeDescriptor(descriptor); if (incoming.has(descriptor.providerId)) throw new ProviderRuntimeError("provider-runtime-duplicate", "Provider 运行时重复。", "discover"); incoming.set(descriptor.providerId, structuredClone(descriptor)); }
      this.descriptors.clear();
      for (const [providerId, descriptor] of incoming) {
        this.descriptors.set(providerId, descriptor);
        const current = this.states.get(providerId);
        if (!current) await this.transition(providerId, "stopped", "provider_runtime_discovered", { displayName: descriptor.displayName }, operationId, context);
      }
      for (const providerId of [...this.states.keys()]) if (!incoming.has(providerId)) { this.states.delete(providerId); this.clearRuntime(providerId); }
      if (incoming.size === 0) await this.emit(null, "provider_runtime_unconfigured", "unconfigured", { message: "当前未配置能力 Provider。" }, operationId, context);
      return this.list();
    } catch (error) { throw normalizeProviderRuntimeError(error, "discover"); }
  }

  public start(request: ProviderRuntimeStartRequest, context?: ProviderSessionContext): Promise<ProviderRuntimeState> {
    const descriptor = this.requireDescriptor(request.providerId);
    const current = this.states.get(request.providerId);
    if (current?.status === "healthy") return Promise.resolve(structuredClone(current));
    const existing = this.operations.get(request.providerId);
    if (existing?.kind === "start" || existing?.kind === "recover") return existing.promise;
    const controller = new AbortController();
    const promise = this.runStart(descriptor, request, controller, context);
    this.operations.set(request.providerId, { kind: "start", controller, promise });
    void promise.finally(() => { if (this.operations.get(request.providerId)?.promise === promise) this.operations.delete(request.providerId); }).catch(() => undefined);
    return promise;
  }

  public async checkHealth(providerId: string, context?: ProviderSessionContext): Promise<ProviderRuntimeState> {
    const instance = this.instances.get(providerId);
    if (!instance) return structuredClone(this.states.get(providerId) ?? this.requireConfiguredState(providerId));
    const existing = this.operations.get(providerId);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const promise = this.runHealth(instance, controller, context);
    this.operations.set(providerId, { kind: "health", controller, promise });
    try { return await promise; } finally { if (this.operations.get(providerId)?.promise === promise) this.operations.delete(providerId); }
  }

  public async stop(providerId: string, context?: ProviderSessionContext): Promise<ProviderRuntimeState> {
    this.requireDescriptor(providerId);
    const current = this.states.get(providerId);
    if (!current || current.status === "stopped") return structuredClone(current ?? this.requireConfiguredState(providerId));
    const existing = this.operations.get(providerId);
    if (existing?.kind === "stop") return existing.promise;
    if (existing) existing.controller.abort();
    const controller = new AbortController();
    const promise = this.runStop(providerId, controller, context);
    this.operations.set(providerId, { kind: "stop", controller, promise });
    try { return await promise; } finally { if (this.operations.get(providerId)?.promise === promise) this.operations.delete(providerId); }
  }

  public async cancel(providerId: string): Promise<boolean> {
    const descriptor = this.requireDescriptor(providerId);
    const operation = this.operations.get(providerId);
    if (!operation) return false;
    if (!descriptor.cancellation) throw new ProviderRuntimeError("provider-runtime-cancellation-unsupported", "此 Provider 运行时不支持取消。", operation.kind === "recover" ? "recover" : operation.kind);
    operation.controller.abort();
    const instance = this.instances.get(providerId);
    if (instance) void this.gateway.cancel(providerId, instance.instanceId).catch(() => false);
    return true;
  }

  private async runStart(descriptor: ProviderRuntimeDescriptor, request: ProviderRuntimeStartRequest, controller: AbortController, context?: ProviderSessionContext): Promise<ProviderRuntimeState> {
    const operationId = this.createId();
    try {
      await this.policy.authorize(request, descriptor.displayName);
    } catch (error) {
      const normalized = normalizeProviderRuntimeError(error, "start");
      await this.emit(request.providerId, "provider_runtime_start_denied", "stopped", {}, operationId, context, normalized);
      throw normalized;
    }
    const generation = this.nextGeneration(request.providerId);
    if (context) this.contexts.set(request.providerId, context);
    await this.transition(request.providerId, "starting", "provider_runtime_starting", {}, operationId, context);
    let instance: ProviderRuntimeInstance | undefined;
    try {
      instance = await this.withControllerTimeout("start", this.timeouts.startMs, controller, (signal) => this.gateway.start(request.providerId, signal));
      this.assertCurrent(request.providerId, generation);
      this.instances.set(request.providerId, instance);
      await this.emit(request.providerId, "provider_runtime_started", "starting", { instanceId: instance.instanceId }, operationId, context);
      const manifest = await this.withControllerTimeout("handshake", this.timeouts.handshakeMs, controller, (signal) => this.gateway.handshake(request.providerId, instance!.instanceId, signal));
      validateProviderManifest(manifest);
      if (manifest.provider_id !== request.providerId) throw new ProviderRuntimeError("provider-runtime-handshake-mismatch", "Provider 握手标识不匹配。", "handshake");
      this.registry.upsert(manifest);
      await this.emit(request.providerId, "provider_runtime_handshake_completed", "starting", {}, operationId, context);
      return await this.completeHealth(instance, operationId, context);
    } catch (error) {
      const phase = error instanceof ProviderRuntimeError ? error.phase : controller.signal.aborted ? "start" : instance ? "handshake" : "start";
      const normalized = normalizeProviderRuntimeError(error, phase);
      if (normalized.code === "provider-runtime-cancelled") {
        this.clearRuntime(request.providerId);
        return this.transition(request.providerId, "stopped", "provider_runtime_cancelled", {}, operationId, context, normalized.message, "如需继续使用，请重新启动 Provider。");
      }
      if (instance) void this.gateway.stop(instance.providerId, instance.instanceId, new AbortController().signal).catch(() => undefined);
      return this.failRuntime(request.providerId, normalized, operationId, context);
    }
  }

  private async runHealth(instance: ProviderRuntimeInstance, controller: AbortController, context?: ProviderSessionContext): Promise<ProviderRuntimeState> {
    const operationId = this.createId();
    try { return await this.completeHealth(instance, operationId, context, controller); }
    catch (error) { return this.failRuntime(instance.providerId, normalizeProviderRuntimeError(error, "health"), operationId, context); }
  }

  private async completeHealth(instance: ProviderRuntimeInstance, operationId: string, context?: ProviderSessionContext, controller = new AbortController()): Promise<ProviderRuntimeState> {
    const health = await this.withControllerTimeout("health", this.timeouts.operationMs, controller, (signal) => this.gateway.checkHealth(instance.providerId, instance.instanceId, signal));
    if (health.status !== "healthy") throw new ProviderRuntimeError("provider-runtime-unhealthy", health.message || "Provider 健康检查未通过。", "health", true);
    const safeMessage = health.message ? String(sanitizeRuntimePayload({ message: health.message }).message) : undefined;
    try { this.registry.setHealth(instance.providerId, { ...health, checkedAt: health.checkedAt || this.now().toISOString() }); } catch { /* Handshake may not have registered a recovered provider yet. */ }
    const state = await this.transition(instance.providerId, "healthy", "provider_runtime_healthy", { checkedAt: health.checkedAt }, operationId, context, safeMessage);
    this.scheduleRunTimeout(instance);
    return state;
  }

  private async runStop(providerId: string, controller: AbortController, context?: ProviderSessionContext): Promise<ProviderRuntimeState> {
    const operationId = this.createId();
    await this.transition(providerId, "stopping", "provider_runtime_stopping", {}, operationId, context);
    try {
      const instance = this.instances.get(providerId);
      if (instance) await this.withControllerTimeout("stop", this.timeouts.operationMs, controller, (signal) => this.gateway.stop(providerId, instance.instanceId, signal));
      this.clearRuntime(providerId); this.setRegistryUnhealthy(providerId, "Provider 已停止。");
      await this.onProviderUnavailable(providerId, new ProviderRuntimeError("provider-runtime-stopped", "Provider 已停止，相关任务已截停。", "stop"));
      return this.transition(providerId, "stopped", "provider_runtime_stopped", {}, operationId, context, "Provider 已停止。", "如需继续使用，请重新启动并检查健康状态。");
    } catch (error) { return this.failRuntime(providerId, normalizeProviderRuntimeError(error, "stop"), operationId, context); }
  }

  private async recoverInstance(instance: ProviderRuntimeInstance, context?: ProviderSessionContext): Promise<ProviderRuntimeState> {
    const descriptor = this.requireDescriptor(instance.providerId);
    const operationId = this.createId(); const controller = new AbortController(); const generation = this.nextGeneration(instance.providerId);
    const promise = (async () => {
      try {
        if (context) this.contexts.set(instance.providerId, context);
        this.instances.set(instance.providerId, instance);
        await this.transition(instance.providerId, "starting", "provider_runtime_recovering", {}, operationId, context);
        const manifest = await this.withControllerTimeout("recover", this.timeouts.handshakeMs, controller, (signal) => this.gateway.handshake(instance.providerId, instance.instanceId, signal));
        this.assertCurrent(instance.providerId, generation); validateProviderManifest(manifest);
        if (manifest.provider_id !== descriptor.providerId) throw new ProviderRuntimeError("provider-runtime-handshake-mismatch", "Provider 恢复握手标识不匹配。", "recover");
        this.registry.upsert(manifest);
        const state = await this.completeHealth(instance, operationId, context, controller);
        await this.emit(instance.providerId, "provider_runtime_recovered", "healthy", {}, operationId, context);
        return state;
      } catch (error) { return this.failRuntime(instance.providerId, normalizeProviderRuntimeError(error, "recover"), operationId, context); }
    })();
    this.operations.set(instance.providerId, { kind: "recover", controller, promise });
    try { return await promise; } finally { if (this.operations.get(instance.providerId)?.promise === promise) this.operations.delete(instance.providerId); }
  }

  private async handleExit(exit: ProviderRuntimeExit): Promise<void> {
    const current = this.instances.get(exit.providerId);
    if (!current || current.instanceId !== exit.instanceId) return;
    const error = normalizeProviderRuntimeError(exit.error, "crash");
    await this.failRuntime(exit.providerId, error, this.createId(), this.contexts.get(exit.providerId), "provider_runtime_crashed");
  }

  private async handleRunTimeout(instance: ProviderRuntimeInstance): Promise<void> {
    if (this.instances.get(instance.providerId)?.instanceId !== instance.instanceId) return;
    void this.gateway.stop(instance.providerId, instance.instanceId, new AbortController().signal).catch(() => undefined);
    await this.failRuntime(instance.providerId, normalizeProviderRuntimeError(Object.assign(new Error("timeout"), { name: "TimeoutError" }), "run"), this.createId(), this.contexts.get(instance.providerId), "provider_runtime_run_timeout");
  }

  private async failRuntime(providerId: string, error: ProviderRuntimeError, operationId: string, context?: ProviderSessionContext, eventType = "provider_runtime_failed"): Promise<ProviderRuntimeState> {
    this.clearRuntime(providerId); this.setRegistryUnhealthy(providerId, error.message); await this.onProviderUnavailable(providerId, error);
    return this.transition(providerId, "unhealthy", eventType, {}, operationId, context, error.message, "请检查 Provider 配置与运行环境后再手动重试。", error);
  }

  private async transition(providerId: string, status: ProviderRuntimeStatus, eventType: string, payload: Record<string, unknown>, operationId: string, context?: ProviderSessionContext, message?: string, recoverySuggestion?: string, error?: ProviderRuntimeError): Promise<ProviderRuntimeState> {
    const descriptor = this.requireDescriptor(providerId); const instance = this.instances.get(providerId); const updatedAt = this.now().toISOString();
    const state: ProviderRuntimeState = { providerId, displayName: descriptor.displayName, status, updatedAt, ...(instance ? { instanceId: instance.instanceId } : {}), ...(status === "healthy" ? { checkedAt: updatedAt } : {}), ...(message ? { message } : {}), ...(recoverySuggestion ? { recoverySuggestion } : {}) };
    this.states.set(providerId, state); await this.emit(providerId, eventType, status, payload, operationId, context, error); return structuredClone(state);
  }

  private async emit(providerId: string | null, eventType: string, status: ProviderRuntimeStatus, payload: Record<string, unknown>, operationId: string, context?: ProviderSessionContext, error?: ProviderRuntimeError): Promise<void> {
    const key = providerId ?? "unconfigured"; const sequence = (this.sequences.get(key) ?? 0) + 1; this.sequences.set(key, sequence);
    const event: ProviderRuntimeEvent = { providerId, operationId, sequence, eventType, status, payload: sanitizeRuntimePayload(payload), ...(error ? { error: { code: error.code, message: error.message } } : {}), emittedAt: this.now().toISOString() };
    if (context && this.persistence) {
      if (providerId) await this.persistState(context, this.states.get(providerId)!, error);
      await this.persistence.recordEvent(context.root, context.session, { eventId: this.createId(), emittedAt: event.emittedAt, category: "provider", eventType, status, taskId: providerId ? runtimeTaskId(providerId) : undefined, payload: sanitizeRuntimePayload({ providerId, ...event.payload, ...(event.error ? { error: event.error } : {}) }), collapsed: true });
      await this.persistence.recordLog(context.root, context.session, { emittedAt: event.emittedAt, level: error ? "error" : status === "unhealthy" ? "warn" : "info", message: eventType, context: sanitizeRuntimePayload({ providerId, status }) });
      await this.onSessionChanged(context);
    }
    this.publishEvent(event);
  }

  private async persistState(context: ProviderSessionContext, state: ProviderRuntimeState, error?: ProviderRuntimeError): Promise<void> {
    if (!this.persistence || !state.providerId) return;
    const taskId = runtimeTaskId(state.providerId); const existing = (await this.persistence.load(context.root, context.session)).tasks.find((task) => task.taskId === taskId); const active = state.status === "starting" || state.status === "stopping";
    const task: SessionTaskState = { taskId, kind: "provider-runtime", providerId: state.providerId, status: active ? "running" : state.status === "unhealthy" ? "failed" : state.status === "healthy" ? "completed" : "stopped", startedAt: existing?.startedAt ?? state.updatedAt, updatedAt: state.updatedAt, ...(!active ? { completedAt: state.updatedAt } : {}), runtimeStatus: state.status, recoverySuggestion: state.recoverySuggestion, result: sanitizeRuntimePayload({ runtimeStatus: state.status, message: state.message, recoverySuggestion: state.recoverySuggestion }), ...(error ? { error: { code: error.code, message: error.message } } : {}) };
    await this.persistence.updateTask(context.root, context.session, task);
  }

  private scheduleRunTimeout(instance: ProviderRuntimeInstance): void { this.clearRunTimer(instance.providerId); this.runTimers.set(instance.providerId, setTimeout(() => { void this.handleRunTimeout(instance); }, this.timeouts.runMs)); }
  private clearRuntime(providerId: string): void { this.instances.delete(providerId); this.contexts.delete(providerId); this.clearRunTimer(providerId); this.nextGeneration(providerId); }
  private clearRunTimer(providerId: string): void { const timer = this.runTimers.get(providerId); if (timer) clearTimeout(timer); this.runTimers.delete(providerId); }
  private nextGeneration(providerId: string): number { const next = (this.generations.get(providerId) ?? 0) + 1; this.generations.set(providerId, next); return next; }
  private assertCurrent(providerId: string, generation: number): void { if (this.generations.get(providerId) !== generation) throw new ProviderRuntimeError("provider-runtime-stale-operation", "Provider 运行时操作已失效。", "start"); }
  private requireDescriptor(providerId: string): ProviderRuntimeDescriptor { const descriptor = this.descriptors.get(providerId); if (!descriptor) throw new ProviderRuntimeError("provider-runtime-unconfigured", "当前未配置此 Provider。", "discover"); return descriptor; }
  private requireConfiguredState(providerId: string): ProviderRuntimeState { const descriptor = this.requireDescriptor(providerId); return { providerId, displayName: descriptor.displayName, status: "stopped", updatedAt: this.now().toISOString() }; }
  private setRegistryUnhealthy(providerId: string, message: string): void { try { this.registry.setHealth(providerId, { status: "unhealthy", checkedAt: this.now().toISOString(), message }); } catch { /* Provider may not have completed a handshake. */ } }
  private withTimeout<T>(phase: import("./providerRuntimeProtocol").ProviderRuntimePhase, milliseconds: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> { return this.withControllerTimeout(phase, milliseconds, new AbortController(), operation); }
  private async withControllerTimeout<T>(phase: import("./providerRuntimeProtocol").ProviderRuntimePhase, milliseconds: number, controller: AbortController, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })); }, milliseconds); });
    try { return await Promise.race([operation(controller.signal), timeout]); } catch (error) { throw normalizeProviderRuntimeError(error, phase); } finally { if (timer) clearTimeout(timer); }
  }
}

function runtimeTaskId(providerId: string): string { return `provider-runtime-${providerId.replace(/[^a-z0-9._-]/gi, "-")}`; }
