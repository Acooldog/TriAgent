import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { StructuredContextCompressor, estimateMessageTokens } from "../../application/settings/contextCompression";
import { SessionPersistenceService, taskStatusForModelError } from "../../application/agent/sessionPersistence";
import { FileSessionRepository } from "../../infrastructure/repositories/sessionRepository";
import { JsonSettingsRepository } from "../../infrastructure/repositories/settingsRepository";
import { FileSystemWorkspaceRepository } from "../../infrastructure/repositories/workspaceRepository";
import { WorkspaceService } from "../../application/workspace/workspaceService";

const tempRoot = path.join(process.cwd(), ".tmp");

async function fixture(): Promise<{ root: string; session: Awaited<ReturnType<FileSystemWorkspaceRepository["createSession"]>>; persistence: SessionPersistenceService }> {
  await mkdir(tempRoot, { recursive: true });
  const root = await mkdtemp(path.join(tempRoot, "session-persistence-"));
  const workspace = new FileSystemWorkspaceRepository();
  const session = await workspace.createSession(root, new Date("2026-08-22T10:20:30.000Z"), "session-test");
  return { root, session, persistence: new SessionPersistenceService(new FileSessionRepository()) };
}

test("persists append-only conversation, config, tasks, events and artifacts", async () => {
  const fixtureValue = await fixture();
  try {
    const { root, session, persistence } = fixtureValue;
    await persistence.appendMessage(root, session, { role: "user", content: "hello" });
    await persistence.appendMessage(root, session, { role: "assistant", content: "hi" });
    await persistence.saveConfig(root, session, { baseUrl: "https://example.test", model: "test", apiKey: "secret", headers: { Authorization: "secret", "X-Auth-Token": "secret", "X-Trace": "safe" } });
    await persistence.updateTask(root, session, { taskId: "task-1", status: "stopped", startedAt: "2026-08-22T10:20:31.000Z", updatedAt: "2026-08-22T10:20:32.000Z", completedAt: "2026-08-22T10:20:32.000Z", error: { code: "cancelled", message: "cancelled" } });
    await persistence.recordEvent(root, session, { eventId: "event-1", emittedAt: "2026-08-22T10:20:32.000Z", category: "task", eventType: "task_stopped", status: "stopped", taskId: "task-1", payload: { reason: "user" } });
    await persistence.recordLog(root, session, { emittedAt: "2026-08-22T10:20:32.000Z", level: "info", message: "task_stopped" });
    await persistence.recordArtifact(root, session, { artifactId: "artifact-1", relativePath: "artifacts/result.txt", kind: "text", createdAt: "2026-08-22T10:20:33.000Z" });
    const before = await readFile(path.join(root, session.relativePath, "conversation.jsonl"), "utf8");
    const loaded = await persistence.load(root, session);
    assert.equal(loaded.messages.length, 2);
    assert.equal(loaded.config.apiKey, undefined);
    assert.deepEqual(loaded.config.headers, { "X-Trace": "safe" });
    assert.equal(loaded.state.status, "stopped");
    assert.equal(loaded.tasks[0]?.taskId, "task-1");
    assert.equal(loaded.events[0]?.eventType, "task_stopped");
    assert.equal(loaded.logs[0]?.message, "task_stopped");
    assert.equal(loaded.artifacts[0]?.artifactId, "artifact-1");
    assert.equal(await readFile(path.join(root, session.relativePath, "conversation.jsonl"), "utf8"), before);
  } finally { await rm(fixtureValue.root, { recursive: true, force: true }); }
});

test("restores stopped state after a fresh repository instance", async () => {
  const fixtureValue = await fixture();
  try {
    const { root, session, persistence } = fixtureValue;
    await persistence.updateTask(root, session, { taskId: "task-stop", status: "stopped", startedAt: session.createdAt, updatedAt: session.createdAt, completedAt: session.createdAt, error: { code: "cancelled", message: "user stopped" } });
    const restored = await new SessionPersistenceService(new FileSessionRepository()).load(root, session);
    assert.equal(restored.state.status, "stopped");
    assert.equal(restored.state.activeTaskId, null);
    assert.equal(restored.tasks[0]?.status, "stopped");
  } finally { await rm(fixtureValue.root, { recursive: true, force: true }); }
});

test("workspace service restores the selected stopped session after restart", async () => {
  const fixtureValue = await fixture();
  try {
    const { root, session, persistence } = fixtureValue;
    const settings = new JsonSettingsRepository(path.join(root, "settings.json"));
    await settings.saveWorkspaceRoot(root);
    await persistence.updateTask(root, session, { taskId: "task-restart", status: "stopped", startedAt: session.createdAt, updatedAt: session.createdAt, completedAt: session.createdAt, error: { code: "cancelled", message: "stopped" } });
    const restarted = new WorkspaceService(new FileSystemWorkspaceRepository(), settings, path.join(root, "install"), () => new Date("2026-08-22T10:22:00.000Z"), () => "new-id", persistence);
    const state = await restarted.initialize();
    assert.equal(state.selectedSession?.state.status, "stopped");
    assert.equal(state.selectedSession?.tasks[0]?.taskId, "task-restart");
  } finally { await rm(fixtureValue.root, { recursive: true, force: true }); }
});

test("compresses structured context, makes markdown by cost, and preserves raw messages", async () => {
  const fixtureValue = await fixture();
  try {
    const { root, session, persistence } = fixtureValue;
    const messages = [{ role: "user" as const, content: "a".repeat(800) }, { role: "assistant" as const, content: "b".repeat(800) }, { role: "user" as const, content: "recent".repeat(200) }];
    for (const message of messages) await persistence.appendMessage(root, session, message);
    const rawBefore = await readFile(path.join(root, session.relativePath, "conversation.jsonl"), "utf8");
    const compressor = new StructuredContextCompressor(async () => "summary", () => new Date("2026-08-22T10:21:00.000Z"));
    const result = await compressor.compress(messages, { thresholdTokens: 1, preserveRecentMessages: 1, markdownThresholdTokens: 1, markdownMaxRatio: 0.8, writeMarkdown: true });
    assert.equal(result.compressed, true);
    assert.equal(result.checkpoint?.summary.content, "summary");
    assert.match(result.markdown ?? "", /Session Checkpoint/);
    assert.equal(result.messages.length, 2);
    assert.equal(await readFile(path.join(root, session.relativePath, "conversation.jsonl"), "utf8"), rawBefore);
    assert.equal(estimateMessageTokens(messages) > 0, true);
    const checkpointId = "checkpoint-1";
    await persistence.writeCheckpoint(root, session, { checkpointId, jsonRelativePath: `checkpoints/${checkpointId}.json`, markdownRelativePath: `checkpoints/${checkpointId}.md`, createdAt: result.checkpoint!.createdAt, messageCount: messages.length, estimatedTokens: result.estimatedTokensBefore, reason: result.reason }, result.checkpoint, result.markdown ?? undefined);
    await persistence.appendMessage(root, session, { role: "assistant", content: "after checkpoint" });
    const active = await persistence.load(root, session);
    assert.equal(active.state.activeCheckpointId, checkpointId);
    assert.deepEqual(active.activeContext, [...result.messages, { role: "assistant", content: "after checkpoint" }]);
    await persistence.restoreOriginalContext(root, session);
    const restored = await persistence.load(root, session);
    assert.equal(restored.state.activeCheckpointId, undefined);
    assert.deepEqual(restored.activeContext, restored.messages);
  } finally { await rm(fixtureValue.root, { recursive: true, force: true }); }
});

test("falls back to original context when compression fails and avoids markdown below threshold", async () => {
  const messages = [{ role: "user" as const, content: "long".repeat(20) }, { role: "assistant" as const, content: "keep" }];
  const failing = new StructuredContextCompressor(async () => { throw new Error("summary unavailable"); });
  const failed = await failing.compress(messages, { thresholdTokens: 1, preserveRecentMessages: 1, writeMarkdown: true });
  assert.equal(failed.fallback, true);
  assert.deepEqual(failed.messages, messages);
  const below = await new StructuredContextCompressor().compress(messages, { thresholdTokens: 1, preserveRecentMessages: 1, markdownThresholdTokens: 99999, writeMarkdown: true });
  assert.equal(below.markdown, null);
});

test("serializes concurrent event writes in call order", async () => {
  const fixtureValue = await fixture();
  try {
    const { root, session, persistence } = fixtureValue;
    await Promise.all(["first", "second", "third"].map((eventType, index) => persistence.recordEvent(root, session, { eventId: String(index), emittedAt: session.createdAt, category: "system", eventType, payload: {} })));
    const loaded = await persistence.load(root, session);
    assert.deepEqual(loaded.events.map((event) => event.eventType), ["first", "second", "third"]);
  } finally { await rm(fixtureValue.root, { recursive: true, force: true }); }
});

test("keeps cancelled model tasks stopped", () => {
  assert.equal(taskStatusForModelError("aborted"), "stopped");
  assert.equal(taskStatusForModelError("cancelled"), "stopped");
  assert.equal(taskStatusForModelError("http-500"), "failed");
});
