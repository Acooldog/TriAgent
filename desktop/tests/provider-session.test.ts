import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { ProviderContractError, type ProviderEvent, type ProviderGateway, type ProviderGatewayResult, type ProviderHealth, type ProviderInvocationRequest, type ProviderManifest } from "../application/providerProtocol";
import { ProviderRegistry } from "../application/providerRegistry";
import { ProviderService } from "../application/providerService";
import { SessionPersistenceService } from "../application/sessionPersistence";
import { WorkspaceService } from "../application/workspaceService";
import { FileSessionRepository } from "../infrastructure/sessionRepository";
import { JsonSettingsRepository } from "../infrastructure/settingsRepository";
import { FileSystemWorkspaceRepository } from "../infrastructure/workspaceRepository";
import { providerManifestFixture } from "./providerFixture";

const tempRoot = path.join(process.cwd(), ".tmp");

class FakeProviderGateway implements ProviderGateway {
  public health: ProviderHealth = { status: "healthy" };
  public events: Array<Pick<ProviderEvent, "event_type" | "status" | "payload" | "error" | "artifacts"> & { sequence?: number }> = [];
  public result: ProviderGatewayResult = { output: { value: "done" } };
  public failure: unknown;
  public waitForAbort = false;
  public ignoreAbort = false;
  public cancelCalls = 0;

  public constructor(public manifests: ProviderManifest[] = [providerManifestFixture()]) {}
  public async discover(): Promise<ProviderManifest[]> { return structuredClone(this.manifests); }
  public async checkHealth(): Promise<ProviderHealth> { if (this.failure) throw this.failure; return structuredClone(this.health); }
  public async invoke(request: ProviderInvocationRequest, onEvent: (event: ProviderEvent) => void, signal: AbortSignal): Promise<ProviderGatewayResult> {
    if (this.waitForAbort) return new Promise((_resolve, reject) => { if (!this.ignoreAbort) signal.addEventListener("abort", () => { const error = new Error("aborted"); error.name = "AbortError"; reject(error); }, { once: true }); });
    for (const [index, event] of this.events.entries()) onEvent({ protocol_version: "1", request_id: request.requestId, task_id: request.taskId, provider_id: request.providerId, capability_id: request.capabilityId, sequence: event.sequence ?? index, emitted_at: `2026-08-23T00:00:0${index}.000Z`, ...event });
    if (this.failure) throw this.failure;
    return structuredClone(this.result);
  }
  public async cancel(): Promise<boolean> { this.cancelCalls += 1; return true; }
}

async function fixture(gateway = new FakeProviderGateway(), timeoutMs = 100): Promise<{ root: string; session: Awaited<ReturnType<FileSystemWorkspaceRepository["createSession"]>>; persistence: SessionPersistenceService; service: ProviderService; gateway: FakeProviderGateway }> {
  await mkdir(tempRoot, { recursive: true });
  const root = await mkdtemp(path.join(tempRoot, "provider-session-"));
  const workspace = new FileSystemWorkspaceRepository();
  const session = await workspace.createSession(root, new Date("2026-08-23T00:00:00.000Z"), "provider-session");
  const persistence = new SessionPersistenceService(new FileSessionRepository());
  const registry = new ProviderRegistry();
  const providerManifest = providerManifestFixture();
  providerManifest.capabilities[0].timeout_ms = timeoutMs;
  registry.register(providerManifest);
  registry.setHealth(providerManifest.provider_id, { status: "healthy" });
  const ids = ["request-provider", "task-provider", "event-1", "event-2", "event-3", "event-4", "event-5"];
  const service = new ProviderService(registry, gateway, persistence, async () => undefined, () => new Date("2026-08-23T00:00:10.000Z"), () => ids.shift() ?? "event-extra");
  return { root, session, persistence, service, gateway };
}

test("preserves provider event order and writes task, logs and artifacts to session", async () => {
  const gateway = new FakeProviderGateway();
  gateway.events = [
    { event_type: "started", status: "running", payload: { token: "hidden", step: 1 } },
    { event_type: "progress", status: "running", payload: { step: 2 }, artifacts: [{ artifact_id: "artifact-event", relative_path: "artifacts/progress.json", kind: "json" }] },
    { event_type: "completed", status: "completed", payload: { step: 3 } },
  ];
  gateway.result = { output: { value: "done" }, artifacts: [{ artifact_id: "artifact-result", relative_path: "artifacts/result.json", kind: "json", metadata: { credential: "hidden" } }] };
  const value = await fixture(gateway);
  try {
    const received: string[] = [];
    const result = await value.service.invoke({ providerId: "example.provider", capabilityId: "example.echo", input: { text: "run" }, permissionMode: "standard" }, { root: value.root, session: value.session }, (event) => received.push(event.event_type));
    assert.deepEqual(received, ["started", "progress", "completed"]);
    assert.equal(result.output && (result.output as Record<string, unknown>).value, "done");
    const snapshot = await value.persistence.load(value.root, value.session);
    assert.equal(snapshot.tasks[0]?.status, "completed");
    assert.equal(snapshot.tasks[0]?.kind, "provider");
    assert.deepEqual(snapshot.events.filter((event) => ["started", "progress", "completed"].includes(event.eventType)).map((event) => event.eventType), ["started", "progress", "completed"]);
    assert.equal((snapshot.events.find((event) => event.eventType === "started")?.payload.payload as Record<string, unknown>).token, "[已脱敏]");
    assert.deepEqual(snapshot.artifacts.map((artifact) => artifact.artifactId), ["artifact-event", "artifact-result"]);
    assert.equal(snapshot.logs.some((log) => log.message === "progress"), true);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("rejects invalid output and sanitizes execution failures", async () => {
  const gateway = new FakeProviderGateway();
  gateway.result = { output: { value: 9 } };
  const value = await fixture(gateway);
  try {
    await assert.rejects(value.service.invoke({ providerId: "example.provider", capabilityId: "example.echo", input: { text: "run" }, permissionMode: "standard" }, { root: value.root, session: value.session }), (error: unknown) => error instanceof ProviderContractError && error.code === "provider-output-schema");
    const snapshot = await value.persistence.load(value.root, value.session);
    assert.equal(snapshot.tasks[0]?.status, "failed");
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("rejects provider events that arrive out of order", async () => {
  const gateway = new FakeProviderGateway();
  gateway.events = [{ event_type: "started", status: "running", payload: {}, sequence: 1 }, { event_type: "progress", status: "running", payload: {}, sequence: 1 }];
  const value = await fixture(gateway);
  try {
    await assert.rejects(value.service.invoke({ providerId: "example.provider", capabilityId: "example.echo", input: { text: "run" }, permissionMode: "standard" }, { root: value.root, session: value.session }), (error: unknown) => error instanceof ProviderContractError && error.code === "provider-event-order");
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("cancels an active provider call", async () => {
  const gateway = new FakeProviderGateway(); gateway.waitForAbort = true;
  const value = await fixture(gateway, 1000);
  try {
    const handle = value.service.start({ providerId: "example.provider", capabilityId: "example.echo", input: { text: "run" }, permissionMode: "standard" }, { root: value.root, session: value.session });
    const completion = assert.rejects(handle.completion, (error: unknown) => error instanceof ProviderContractError && error.code === "provider-cancelled");
    assert.equal(handle.taskId, "task-provider");
    assert.equal(await value.service.cancel(handle.taskId), true);
    await completion;
    assert.equal(gateway.cancelCalls, 1);
    const snapshot = await value.persistence.load(value.root, value.session);
    assert.equal(snapshot.tasks[0]?.status, "stopped");
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("times out a provider that does not stop itself", async () => {
  const gateway = new FakeProviderGateway(); gateway.waitForAbort = true; gateway.ignoreAbort = true;
  const value = await fixture(gateway, 15);
  try {
    await assert.rejects(value.service.invoke({ providerId: "example.provider", capabilityId: "example.echo", input: { text: "run" }, permissionMode: "standard" }, { root: value.root, session: value.session }), (error: unknown) => error instanceof ProviderContractError && error.code === "provider-timeout");
    assert.equal(gateway.cancelCalls, 1);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("marks failed health checks without removing a valid registration", async () => {
  const gateway = new FakeProviderGateway(); gateway.failure = new Error("health unavailable");
  const registry = new ProviderRegistry();
  const service = new ProviderService(registry, gateway);
  const registrations = await service.refresh();
  assert.equal(registrations[0]?.health.status, "unhealthy");
  assert.equal(registrations[0]?.manifest.provider_id, "example.provider");
});

test("recovers an interrupted provider task as stopped after application restart", async () => {
  const value = await fixture();
  try {
    await value.persistence.updateTask(value.root, value.session, { taskId: "task-restart", kind: "provider", providerId: "example.provider", capabilityId: "example.echo", status: "running", startedAt: value.session.createdAt, updatedAt: value.session.createdAt });
    const settings = new JsonSettingsRepository(path.join(value.root, "settings.json"));
    await settings.saveWorkspaceRoot(value.root);
    const restarted = new WorkspaceService(new FileSystemWorkspaceRepository(), settings, path.join(value.root, "install"), () => new Date(), () => "unused", new SessionPersistenceService(new FileSessionRepository()));
    const state = await restarted.initialize();
    assert.equal(state.selectedSession?.tasks[0]?.status, "stopped");
    assert.equal(state.selectedSession?.tasks[0]?.error?.code, "provider-interrupted");
    assert.equal(state.selectedSession?.state.activeTaskId, null);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("does not stop a live provider task on later workspace refresh", async () => {
  const value = await fixture();
  try {
    const settings = new JsonSettingsRepository(path.join(value.root, "settings.json"));
    const persistence = new SessionPersistenceService(new FileSessionRepository());
    const workspace = new WorkspaceService(new FileSystemWorkspaceRepository(), settings, path.join(value.root, "install"), () => new Date(), () => "unused", persistence);
    await workspace.initialize();
    await workspace.chooseWorkspaceRoot(value.root);
    await persistence.updateTask(value.root, value.session, { taskId: "task-live", kind: "provider", providerId: "example.provider", capabilityId: "example.echo", status: "running", startedAt: value.session.createdAt, updatedAt: value.session.createdAt });
    const selectedAgain = await workspace.chooseWorkspaceRoot(value.root);
    assert.equal(selectedAgain.selectedSession?.tasks[0]?.status, "running");
  } finally { await rm(value.root, { recursive: true, force: true }); }
});
