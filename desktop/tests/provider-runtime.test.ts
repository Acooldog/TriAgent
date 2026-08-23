import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { ProviderContractError, type ProviderEvent, type ProviderGateway, type ProviderGatewayResult, type ProviderHealth, type ProviderInvocationRequest, type ProviderManifest } from "../application/providerProtocol";
import { ProviderRegistry } from "../application/providerRegistry";
import { ProviderService } from "../application/providerService";
import { ProviderRuntimeStartPolicy } from "../application/providerRuntimePolicy";
import { ProviderRuntimeError, type ProviderRuntimeDescriptor, type ProviderRuntimeExit, type ProviderRuntimeGateway, type ProviderRuntimeInstance } from "../application/providerRuntimeProtocol";
import { ProviderRuntimeService } from "../application/providerRuntimeService";
import { SessionPersistenceService } from "../application/sessionPersistence";
import { FileSessionRepository } from "../infrastructure/sessionRepository";
import { FileSystemWorkspaceRepository } from "../infrastructure/workspaceRepository";
import { providerManifestFixture } from "./providerFixture";

class FakeRuntimeGateway implements ProviderRuntimeGateway {
  public descriptors: ProviderRuntimeDescriptor[] = [{ providerId: "example.provider", displayName: "示例 Provider", cancellation: true }];
  public startFailure: unknown;
  public handshakeFailure: unknown;
  public health: ProviderHealth = { status: "healthy" };
  public waitForStart = false;
  public startCalls = 0;
  public stopCalls = 0;
  public readonly exits: Array<ProviderRuntimeExit> = [];
  private readonly listeners = new Set<(event: ProviderRuntimeExit) => void>();
  private releaseStart!: () => void;

  public async discover(_signal: AbortSignal): Promise<ProviderRuntimeDescriptor[]> { return structuredClone(this.descriptors); }
  public async start(providerId: string, signal: AbortSignal): Promise<ProviderRuntimeInstance> {
    this.startCalls += 1;
    if (this.startFailure) throw this.startFailure;
    if (this.waitForStart) await new Promise<void>((resolve, reject) => { this.releaseStart = resolve; signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true }); });
    return { providerId, instanceId: `${providerId}-instance-${this.startCalls}` };
  }
  public async handshake(_providerId: string, _instanceId: string, _signal: AbortSignal): Promise<ProviderManifest> { if (this.handshakeFailure) throw this.handshakeFailure; return providerManifestFixture(); }
  public async checkHealth(_providerId: string, _instanceId: string, _signal: AbortSignal): Promise<ProviderHealth> { return structuredClone(this.health); }
  public async stop(_providerId: string, _instanceId: string, _signal: AbortSignal): Promise<void> { this.stopCalls += 1; }
  public async cancel(): Promise<boolean> { return true; }
  public async recover(_signal: AbortSignal): Promise<ProviderRuntimeInstance[]> { return []; }
  public onExit(listener: (event: ProviderRuntimeExit) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  public release(): void { this.releaseStart?.(); }
  public emitExit(event: ProviderRuntimeExit): void { this.exits.push(event); for (const listener of this.listeners) listener(event); }
}

class BlockingProviderGateway implements ProviderGateway {
  public async discover(): Promise<ProviderManifest[]> { return [providerManifestFixture()]; }
  public async checkHealth(): Promise<ProviderHealth> { return { status: "healthy" }; }
  public async invoke(_request: ProviderInvocationRequest, _onEvent: (event: ProviderEvent) => void, signal: AbortSignal): Promise<ProviderGatewayResult> {
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true }));
  }
  public async cancel(): Promise<boolean> { return true; }
}

function createService(gateway = new FakeRuntimeGateway(), approval = true, unavailable: string[] = [], persistence?: SessionPersistenceService, events: string[] = [], runMs = 1_000) {
  const registry = new ProviderRegistry();
  const service = new ProviderRuntimeService(gateway, registry, new ProviderRuntimeStartPolicy({ requestStartApproval: async () => approval }), persistence, undefined, (providerId) => { unavailable.push(providerId); }, (event) => { events.push(event.eventType); }, { discoveryMs: 20, startMs: 20, handshakeMs: 20, operationMs: 20, runMs });
  return { gateway, service, unavailable };
}

test("reports an understandable unconfigured state", async () => {
  const gateway = new FakeRuntimeGateway(); gateway.descriptors = [];
  const { service } = createService(gateway);
  const states = await service.initialize();
  assert.deepEqual(states[0], { providerId: null, displayName: "能力 Provider", status: "unconfigured", message: "当前未配置能力 Provider。", recoverySuggestion: "请安装或配置受支持的 Provider 后刷新。", updatedAt: states[0]?.updatedAt });
});

test("enforces restricted denial and standard approval", async () => {
  const deniedEvents: string[] = []; const denied = createService(new FakeRuntimeGateway(), false, [], undefined, deniedEvents);
  await denied.service.initialize();
  await assert.rejects(denied.service.start({ providerId: "example.provider", permissionMode: "restricted" }), (error: unknown) => error instanceof ProviderRuntimeError && error.code === "provider-runtime-restricted");
  await assert.rejects(denied.service.start({ providerId: "example.provider", permissionMode: "standard" }), (error: unknown) => error instanceof ProviderRuntimeError && error.code === "provider-runtime-approval-denied");
  assert.deepEqual(deniedEvents, ["provider_runtime_discovered", "provider_runtime_start_denied", "provider_runtime_start_denied"]);
  const allowed = createService();
  await allowed.service.initialize();
  assert.equal((await allowed.service.start({ providerId: "example.provider", permissionMode: "standard" })).status, "healthy");
  assert.equal((await allowed.service.start({ providerId: "example.provider", permissionMode: "full" })).status, "healthy");
  assert.equal(allowed.gateway.startCalls, 1);
});

test("runs start, handshake, health, stop and repeated stop transitions", async () => {
  const value = createService();
  await value.service.initialize();
  assert.equal(value.service.list().find((state) => state.providerId === "example.provider")?.status, "stopped");
  assert.equal((await value.service.start({ providerId: "example.provider", permissionMode: "full" })).status, "healthy");
  assert.equal((await value.service.checkHealth("example.provider")).status, "healthy");
  assert.equal((await value.service.stop("example.provider")).status, "stopped");
  assert.equal((await value.service.stop("example.provider")).status, "stopped");
  assert.equal(value.gateway.stopCalls, 1);
});

test("keeps runtime event sequence ordered and stops after run timeout", async () => {
  const events: string[] = []; const value = createService(new FakeRuntimeGateway(), true, [], undefined, events, 20); await value.service.initialize();
  await value.service.start({ providerId: "example.provider", permissionMode: "full" });
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(value.service.list().find((state) => state.providerId === "example.provider")?.status, "unhealthy");
  assert.deepEqual(events.slice(0, 5), ["provider_runtime_discovered", "provider_runtime_starting", "provider_runtime_started", "provider_runtime_handshake_completed", "provider_runtime_healthy"]);
  assert.equal(events.includes("provider_runtime_run_timeout"), true);
});

test("normalizes start, handshake and health failures", async () => {
  const start = createService(); start.gateway.startFailure = new Error("internal start path"); await start.service.initialize();
  assert.equal((await start.service.start({ providerId: "example.provider", permissionMode: "full" })).status, "unhealthy");
  const handshake = createService(); handshake.gateway.handshakeFailure = new Error("internal handshake detail"); await handshake.service.initialize();
  const handshakeState = await handshake.service.start({ providerId: "example.provider", permissionMode: "full" }); assert.equal(handshakeState.status, "unhealthy"); assert.doesNotMatch(handshakeState.message ?? "", /internal/);
  const health = createService(); health.gateway.health = { status: "unhealthy", message: "token=private-value" }; await health.service.initialize();
  const healthState = await health.service.start({ providerId: "example.provider", permissionMode: "full" }); assert.equal(healthState.status, "unhealthy"); assert.doesNotMatch(healthState.message ?? "", /private-value/);
  const handshakeTimeout = createService(); handshakeTimeout.gateway.handshakeFailure = Object.assign(new Error("timeout"), { name: "TimeoutError" }); await handshakeTimeout.service.initialize();
  const handshakeTimeoutState = await handshakeTimeout.service.start({ providerId: "example.provider", permissionMode: "full" }); assert.equal(handshakeTimeoutState.status, "unhealthy");
});

test("normalizes start timeout and unsupported cancellation", async () => {
  const timeout = createService(); timeout.gateway.waitForStart = true; await timeout.service.initialize();
  const result = await timeout.service.start({ providerId: "example.provider", permissionMode: "full" }); assert.equal(result.status, "unhealthy"); assert.match(result.message ?? "", /超时|失败/);
  const unsupportedGateway = new FakeRuntimeGateway(); unsupportedGateway.descriptors[0].cancellation = false; unsupportedGateway.waitForStart = true;
  const unsupported = createService(unsupportedGateway); await unsupported.service.initialize(); const pending = unsupported.service.start({ providerId: "example.provider", permissionMode: "full" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await assert.rejects(unsupported.service.cancel("example.provider"), (error: unknown) => error instanceof ProviderRuntimeError && error.code === "provider-runtime-cancellation-unsupported");
  unsupportedGateway.release(); await pending;
});

test("isolates late exit events and stops active calls after a crash", async () => {
  const unavailable: string[] = []; const value = createService(new FakeRuntimeGateway(), true, unavailable); await value.service.initialize();
  const first = await value.service.start({ providerId: "example.provider", permissionMode: "full" }); const firstId = first.instanceId!;
  await value.service.stop("example.provider");
  const second = await value.service.start({ providerId: "example.provider", permissionMode: "full" });
  value.gateway.emitExit({ providerId: "example.provider", instanceId: firstId, exitCode: 1 });
  assert.equal(value.service.list().find((state) => state.providerId === "example.provider")?.status, "healthy");
  value.gateway.emitExit({ providerId: "example.provider", instanceId: second.instanceId! });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(value.service.list().find((state) => state.providerId === "example.provider")?.status, "unhealthy");
  assert.deepEqual(unavailable, ["example.provider", "example.provider"]);
});

test("stops active provider calls when the runtime crashes", async () => {
  const registry = new ProviderRegistry(); const manifest = providerManifestFixture(); registry.register(manifest); registry.setHealth(manifest.provider_id, { status: "healthy" });
  const service = new ProviderService(registry, new BlockingProviderGateway());
  const handle = service.start({ providerId: manifest.provider_id, capabilityId: manifest.capabilities[0].capability_id, input: { text: "run" }, permissionMode: "standard" });
  const completion = assert.rejects(handle.completion, (error: unknown) => error instanceof ProviderContractError && error.code === "provider-runtime-crashed");
  assert.equal(service.stopProvider(manifest.provider_id, new ProviderContractError("provider-runtime-crashed", "Provider 运行时异常退出。")), 1);
  await completion;
});

test("writes runtime status, events and recovery suggestion to session", async () => {
  const root = await mkdtemp(path.join(process.cwd(), ".tmp", "provider-runtime-"));
  try {
    await mkdir(root, { recursive: true });
    const workspace = new FileSystemWorkspaceRepository(); const session = await workspace.createSession(root, new Date("2026-08-23T00:00:00.000Z"), "runtime-session");
    const persistence = new SessionPersistenceService(new FileSessionRepository()); const value = createService(new FakeRuntimeGateway(), true, [], persistence);
    const context = { root, session }; await value.service.initialize(context); await value.service.start({ providerId: "example.provider", permissionMode: "full" }, context); await value.service.stop("example.provider", context);
    const snapshot = await persistence.load(root, session); const runtimeTask = snapshot.tasks.find((task) => task.kind === "provider-runtime");
    assert.equal(runtimeTask?.runtimeStatus, "stopped"); assert.equal(snapshot.events.some((event) => event.eventType === "provider_runtime_stopped"), true); assert.equal(snapshot.logs.some((log) => log.message === "provider_runtime_stopped"), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("recovers persisted runtime tasks as stopped after restart", async () => {
  const root = await mkdtemp(path.join(process.cwd(), ".tmp", "provider-runtime-recovery-"));
  try {
    const workspace = new FileSystemWorkspaceRepository(); const session = await workspace.createSession(root, new Date("2026-08-23T00:00:00.000Z"), "runtime-recovery"); const persistence = new SessionPersistenceService(new FileSessionRepository());
    await persistence.updateTask(root, session, { taskId: "provider-runtime-example", kind: "provider-runtime", providerId: "example.provider", status: "running", runtimeStatus: "healthy", startedAt: session.createdAt, updatedAt: session.createdAt });
    await persistence.recoverInterruptedTasks(root, session);
    const snapshot = await persistence.load(root, session); const task = snapshot.tasks.find((item) => item.taskId === "provider-runtime-example");
    assert.equal(task?.status, "stopped"); assert.equal(task?.runtimeStatus, "stopped"); assert.equal(task?.recoverySuggestion, "请重新启动 Provider 并检查健康状态。"); assert.equal(snapshot.events.some((event) => event.eventType === "provider_runtime_restore_stopped"), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
