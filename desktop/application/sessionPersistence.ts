import type { ChatMessage, ModelConfig } from "./modelProtocol";
import type { SessionInfo } from "./workspaceService";

export type SessionStatus = "idle" | "running" | "stopped" | "completed" | "failed";
export interface SessionState { status: SessionStatus; activeTaskId: string | null; updatedAt: string; stopReason?: string; }
export interface SessionTaskState { taskId: string; status: SessionStatus; startedAt: string; updatedAt: string; completedAt?: string; requestId?: string; error?: { code: string; message: string }; result?: Record<string, unknown>; }
export interface SessionEventRecord { eventId: string; emittedAt: string; category: "model" | "worker" | "task" | "system"; eventType: string; status?: string; taskId?: string; requestId?: string; payload: Record<string, unknown>; collapsed?: boolean; }
export interface SessionLogRecord { emittedAt: string; level: "debug" | "info" | "warn" | "error"; message: string; context?: Record<string, unknown>; }
export interface ArtifactReference { artifactId: string; relativePath: string; kind: string; createdAt: string; metadata?: Record<string, unknown>; }
export interface CheckpointReference { checkpointId: string; relativePath: string; format: "json" | "markdown"; createdAt: string; messageCount: number; estimatedTokens: number; reason: string; }
export interface SessionSnapshot { session: SessionInfo; config: Record<string, unknown>; messages: ChatMessage[]; state: SessionState; tasks: SessionTaskState[]; events: SessionEventRecord[]; logs: SessionLogRecord[]; artifacts: ArtifactReference[]; checkpoints: CheckpointReference[]; }
export interface SessionStore { load(root: string, session: SessionInfo): Promise<SessionSnapshot>; appendMessage(root: string, session: SessionInfo, message: ChatMessage): Promise<void>; writeConfig(root: string, session: SessionInfo, config: Record<string, unknown>): Promise<void>; writeTaskState(root: string, session: SessionInfo, task: SessionTaskState): Promise<void>; appendEvent(root: string, session: SessionInfo, event: SessionEventRecord): Promise<void>; appendLog(root: string, session: SessionInfo, log: SessionLogRecord): Promise<void>; appendArtifact(root: string, session: SessionInfo, artifact: ArtifactReference): Promise<void>; writeCheckpoint(root: string, session: SessionInfo, checkpoint: CheckpointReference, payload: unknown, markdown?: string): Promise<void>; }

export class SessionPersistenceService {
  public constructor(private readonly store: SessionStore) {}
  public load(root: string, session: SessionInfo): Promise<SessionSnapshot> { return this.store.load(root, session); }
  public appendMessage(root: string, session: SessionInfo, message: ChatMessage): Promise<void> { return this.store.appendMessage(root, session, message); }
  public saveConfig(root: string, session: SessionInfo, config: ModelConfig, extra: Record<string, unknown> = {}): Promise<void> { return this.store.writeConfig(root, session, { ...sanitizeConfig(config), ...extra }); }
  public updateTask(root: string, session: SessionInfo, task: SessionTaskState): Promise<void> { return this.store.writeTaskState(root, session, task); }
  public recordEvent(root: string, session: SessionInfo, event: SessionEventRecord): Promise<void> { return this.store.appendEvent(root, session, event); }
  public recordLog(root: string, session: SessionInfo, log: SessionLogRecord): Promise<void> { return this.store.appendLog(root, session, log); }
  public recordArtifact(root: string, session: SessionInfo, artifact: ArtifactReference): Promise<void> { return this.store.appendArtifact(root, session, artifact); }
  public writeCheckpoint(root: string, session: SessionInfo, checkpoint: CheckpointReference, payload: unknown, markdown?: string): Promise<void> { return this.store.writeCheckpoint(root, session, checkpoint, payload, markdown); }
}

function sanitizeConfig(config: ModelConfig): Record<string, unknown> {
  const sanitized: Record<string, unknown> = { ...config };
  delete sanitized.apiKey;
  if (config.headers) sanitized.headers = Object.fromEntries(Object.entries(config.headers).filter(([key]) => !/authorization|api[-_]?key/i.test(key)));
  return sanitized;
}
