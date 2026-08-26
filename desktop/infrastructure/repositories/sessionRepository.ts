import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ChatMessage } from "../application/model/modelProtocol";
import type { CompressionCheckpoint } from "../application/settings/contextCompression";
import type { ArtifactReference, CheckpointReference, SessionEventRecord, SessionLogRecord, SessionState, SessionStore, SessionTaskState, SessionSnapshot } from "../application/agent/sessionPersistence";
import type { SessionInfo } from "../application/workspace/workspaceService";

export class FileSessionRepository implements SessionStore {
  private readonly queues = new Map<string, Promise<void>>();

  public async load(root: string, session: SessionInfo): Promise<SessionSnapshot> {
    const directory = sessionDirectory(root, session);
    await this.waitForWrites(directory);
    const [config, state, messages, events, logs, artifacts, checkpoints, tasks] = await Promise.all([
      readJsonObject(path.join(directory, "config.json")),
      readJsonObject(path.join(directory, "state.json")),
      readJsonLines<ChatMessage>(path.join(directory, "conversation.jsonl")),
      readJsonLines<SessionEventRecord>(path.join(directory, "events.jsonl")),
      readJsonLines<SessionLogRecord>(path.join(directory, "logs.jsonl")),
      readJsonLines<ArtifactReference>(path.join(directory, "artifacts.jsonl")),
      readJsonLines<CheckpointReference>(path.join(directory, "checkpoints", "index.jsonl")),
      readTaskStates(path.join(directory, "tasks")),
    ]);
    const normalizedState = normalizeSessionState(state, session.createdAt);
    const activeContext = await readActiveContext(directory, normalizedState.activeCheckpointId, messages);
    return { session, config, messages, state: normalizedState, tasks, events, logs, artifacts, checkpoints, activeContext };
  }

  public appendMessage(root: string, session: SessionInfo, message: ChatMessage): Promise<void> {
    const directory = sessionDirectory(root, session);
    return this.enqueue(directory, () => appendJsonLine(path.join(directory, "conversation.jsonl"), message));
  }

  public async recoverInterruptedTasks(root: string, session: SessionInfo): Promise<void> {
    const directory = sessionDirectory(root, session);
    await this.enqueue(directory, async () => {
      const tasks = await readTaskStates(path.join(directory, "tasks"));
      const interrupted = tasks.filter((task) => task.kind === "provider" && task.status === "running");
      const runtimes = tasks.filter((task) => task.kind === "provider-runtime" && (task.status === "running" || task.runtimeStatus === "healthy" || task.runtimeStatus === "starting" || task.runtimeStatus === "stopping"));
      if (interrupted.length === 0 && runtimes.length === 0) return;
      const updatedAt = new Date().toISOString();
      for (const task of interrupted) {
        await writeJson(path.join(directory, "tasks", task.taskId, "state.json"), { ...task, status: "stopped", updatedAt, completedAt: updatedAt, error: { code: "provider-interrupted", message: "应用重启后，未完成的 Provider 任务已停止。" } });
        await appendJsonLine(path.join(directory, "events.jsonl"), { eventId: randomUUID(), emittedAt: updatedAt, category: "provider", eventType: "provider_interrupted", status: "stopped", taskId: task.taskId, requestId: task.requestId, payload: { providerId: task.providerId, capabilityId: task.capabilityId }, collapsed: true } satisfies SessionEventRecord);
        await appendJsonLine(path.join(directory, "logs.jsonl"), { emittedAt: updatedAt, level: "warn", message: "provider_interrupted", context: { providerId: task.providerId, capabilityId: task.capabilityId, taskId: task.taskId } } satisfies SessionLogRecord);
      }
      for (const task of runtimes) {
        const message = "应用重启后，Provider 运行时状态已恢复为已停止。";
        await writeJson(path.join(directory, "tasks", task.taskId, "state.json"), { ...task, status: "stopped", runtimeStatus: "stopped", updatedAt, completedAt: updatedAt, recoverySuggestion: "请重新启动 Provider 并检查健康状态。", error: { code: "provider-runtime-restart", message } });
        await appendJsonLine(path.join(directory, "events.jsonl"), { eventId: randomUUID(), emittedAt: updatedAt, category: "provider", eventType: "provider_runtime_restore_stopped", status: "stopped", taskId: task.taskId, payload: { providerId: task.providerId, recoverySuggestion: "请重新启动 Provider 并检查健康状态。" }, collapsed: true } satisfies SessionEventRecord);
        await appendJsonLine(path.join(directory, "logs.jsonl"), { emittedAt: updatedAt, level: "warn", message: "provider_runtime_restore_stopped", context: { providerId: task.providerId, taskId: task.taskId } } satisfies SessionLogRecord);
      }
      const state = normalizeSessionState(await readJsonObject(path.join(directory, "state.json")), session.createdAt);
      if (state.activeTaskId && [...interrupted, ...runtimes].some((task) => task.taskId === state.activeTaskId)) await writeJson(path.join(directory, "state.json"), { ...state, status: "stopped", activeTaskId: null, updatedAt, stopReason: "应用重启后，未完成的 Provider 任务已停止。" });
    });
  }

  public writeConfig(root: string, session: SessionInfo, config: Record<string, unknown>): Promise<void> {
    const directory = sessionDirectory(root, session);
    return this.enqueue(directory, () => writeJson(path.join(directory, "config.json"), config));
  }

  public async writeTaskState(root: string, session: SessionInfo, task: SessionTaskState): Promise<void> {
    const directory = sessionDirectory(root, session);
    await this.enqueue(directory, async () => {
      await writeJson(path.join(directory, "tasks", task.taskId, "state.json"), task);
      if (task.kind === "provider-runtime") return;
      const current = normalizeSessionState(await readJsonObject(path.join(directory, "state.json")), task.startedAt);
      const status: SessionStatusForState = task.status === "running" ? "running" : task.status;
      await writeJson(path.join(directory, "state.json"), { ...current, status, activeTaskId: status === "running" ? task.taskId : null, updatedAt: task.updatedAt, ...(task.error ? { stopReason: task.error.message } : {}) });
    });
  }

  public appendEvent(root: string, session: SessionInfo, event: SessionEventRecord): Promise<void> {
    const directory = sessionDirectory(root, session);
    return this.enqueue(directory, () => appendJsonLine(path.join(directory, "events.jsonl"), event));
  }

  public appendLog(root: string, session: SessionInfo, log: SessionLogRecord): Promise<void> {
    const directory = sessionDirectory(root, session);
    return this.enqueue(directory, () => appendJsonLine(path.join(directory, "logs.jsonl"), log));
  }

  public appendArtifact(root: string, session: SessionInfo, artifact: ArtifactReference): Promise<void> {
    const directory = sessionDirectory(root, session);
    return this.enqueue(directory, () => appendJsonLine(path.join(directory, "artifacts.jsonl"), artifact));
  }

  public async writeCheckpoint(root: string, session: SessionInfo, checkpoint: CheckpointReference, payload: unknown, markdown?: string): Promise<void> {
    const directory = sessionDirectory(root, session);
    await this.enqueue(directory, async () => {
      await writeJson(resolveSessionChild(directory, checkpoint.jsonRelativePath), payload);
      if (markdown && checkpoint.markdownRelativePath) {
        await writeFile(resolveSessionChild(directory, checkpoint.markdownRelativePath), markdown, "utf8");
      }
      await appendJsonLine(path.join(directory, "checkpoints", "index.jsonl"), checkpoint);
      const current = normalizeSessionState(await readJsonObject(path.join(directory, "state.json")), checkpoint.createdAt);
      await writeJson(path.join(directory, "state.json"), { ...current, activeCheckpointId: checkpoint.checkpointId, updatedAt: checkpoint.createdAt });
    });
  }

  public async restoreOriginalContext(root: string, session: SessionInfo): Promise<void> {
    const directory = sessionDirectory(root, session);
    await this.enqueue(directory, async () => {
      const current = normalizeSessionState(await readJsonObject(path.join(directory, "state.json")), session.createdAt);
      const { activeCheckpointId: _ignored, ...restored } = current;
      await writeJson(path.join(directory, "state.json"), { ...restored, updatedAt: new Date().toISOString() });
    });
  }

  private enqueue(directory: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(directory) ?? Promise.resolve();
    const current = previous.then(operation);
    this.queues.set(directory, current.catch(() => undefined));
    return current;
  }

  private async waitForWrites(directory: string): Promise<void> {
    await (this.queues.get(directory) ?? Promise.resolve());
  }
}

export function sessionDirectory(root: string, session: SessionInfo): string {
  const resolvedRoot = path.resolve(root);
  const directory = path.resolve(root, session.relativePath);
  if (directory !== resolvedRoot && !directory.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("会话路径超出工作区范围。");
  return directory;
}

export async function initializeSessionFiles(root: string, session: SessionInfo): Promise<void> {
  const directory = sessionDirectory(root, session);
  await Promise.all([
    mkdir(path.join(directory, "tasks"), { recursive: true }),
    mkdir(path.join(directory, "checkpoints"), { recursive: true }),
    appendFile(path.join(directory, "conversation.jsonl"), "", "utf8"),
    appendFile(path.join(directory, "events.jsonl"), "", "utf8"),
    appendFile(path.join(directory, "logs.jsonl"), "", "utf8"),
    appendFile(path.join(directory, "artifacts.jsonl"), "", "utf8"),
    writeJson(path.join(directory, "config.json"), {}),
    writeJson(path.join(directory, "state.json"), { status: "idle", activeTaskId: null, updatedAt: session.createdAt }),
  ]);
}

type SessionStatusForState = "idle" | "running" | "stopped" | "completed" | "failed";

function normalizeSessionState(value: Record<string, unknown>, createdAt: string): SessionState {
  const status = ["idle", "running", "stopped", "completed", "failed"].includes(String(value.status)) ? String(value.status) as SessionStatusForState : "idle";
  return { status, activeTaskId: typeof value.activeTaskId === "string" ? value.activeTaskId : null, updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : createdAt, ...(typeof value.activeCheckpointId === "string" ? { activeCheckpointId: value.activeCheckpointId } : {}), ...(typeof value.stopReason === "string" ? { stopReason: value.stopReason } : {}) };
}

async function readActiveContext(directory: string, checkpointId: string | undefined, messages: ChatMessage[]): Promise<ChatMessage[]> {
  if (!checkpointId) return messages.map((message) => ({ ...message }));
  const payload = await readJsonObject(path.join(directory, "checkpoints", `${checkpointId}.json`));
  const checkpoint = payload as unknown as Partial<CompressionCheckpoint>;
  if (!Array.isArray(checkpoint.compressedMessages) || typeof checkpoint.originalMessageCount !== "number") {
    throw new Error(`检查点 ${checkpointId} 格式无效。`);
  }
  return [...checkpoint.compressedMessages.map((message) => ({ ...message })), ...messages.slice(checkpoint.originalMessageCount).map((message) => ({ ...message }))];
}

function resolveSessionChild(directory: string, relativePath: string): string {
  const resolved = path.resolve(directory, relativePath);
  if (!resolved.startsWith(`${path.resolve(directory)}${path.sep}`)) throw new Error("会话文件路径超出会话目录范围。");
  return resolved;
}

async function readTaskStates(directory: string): Promise<SessionTaskState[]> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (isMissing(error)) return []; throw error; }
  const tasks: SessionTaskState[] = [];
  for (const entry of entries.filter((item) => item.isDirectory())) {
    const task = await readJsonObject(path.join(directory, entry.name, "state.json"));
    if (typeof task.taskId === "string" && typeof task.status === "string") tasks.push(task as unknown as SessionTaskState);
  }
  return tasks.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

async function readJsonLines<T>(file: string): Promise<T[]> {
  let text: string;
  try { text = await readFile(file, "utf8"); } catch (error) { if (isMissing(error)) return []; throw error; }
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as T);
}

async function readJsonObject(file: string): Promise<Record<string, unknown>> {
  try { return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>; } catch (error) { if (isMissing(error)) return {}; throw error; }
}

async function appendJsonLine(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(value)}\n`, "utf8");
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
  await rename(temporary, file);
}

function isMissing(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
