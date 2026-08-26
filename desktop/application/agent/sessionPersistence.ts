import type { ChatMessage, ModelConfig } from "../model/modelProtocol";
import type { SessionInfo } from "../workspace/workspaceService";

export type SessionStatus = "idle" | "running" | "stopped" | "completed" | "failed";

export interface SessionState {
  status: SessionStatus;
  activeTaskId: string | null;
  activeCheckpointId?: string;
  updatedAt: string;
  stopReason?: string;
}

export interface SessionTaskState {
  taskId: string;
  kind?: "model" | "worker" | "provider" | "provider-runtime";
  providerId?: string;
  capabilityId?: string;
  status: SessionStatus;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  requestId?: string;
  error?: { code: string; message: string };
  result?: Record<string, unknown>;
  runtimeStatus?: import("../provider/providerRuntimeProtocol").ProviderRuntimeStatus;
  recoverySuggestion?: string;
}

export interface SessionEventRecord {
  eventId: string;
  emittedAt: string;
  category: "model" | "worker" | "provider" | "task" | "system";
  eventType: string;
  status?: string;
  taskId?: string;
  requestId?: string;
  payload: Record<string, unknown>;
  collapsed?: boolean;
}

export interface SessionLogRecord {
  emittedAt: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  context?: Record<string, unknown>;
}

export interface ArtifactReference {
  artifactId: string;
  relativePath: string;
  kind: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface CheckpointReference {
  checkpointId: string;
  jsonRelativePath: string;
  markdownRelativePath?: string;
  createdAt: string;
  messageCount: number;
  estimatedTokens: number;
  reason: string;
}

export interface SessionSnapshot {
  session: SessionInfo;
  config: Record<string, unknown>;
  messages: ChatMessage[];
  state: SessionState;
  tasks: SessionTaskState[];
  events: SessionEventRecord[];
  logs: SessionLogRecord[];
  artifacts: ArtifactReference[];
  checkpoints: CheckpointReference[];
  activeContext: ChatMessage[];
}

export interface SessionStore {
  load(root: string, session: SessionInfo): Promise<SessionSnapshot>;
  recoverInterruptedTasks(root: string, session: SessionInfo): Promise<void>;
  appendMessage(root: string, session: SessionInfo, message: ChatMessage): Promise<void>;
  writeConfig(root: string, session: SessionInfo, config: Record<string, unknown>): Promise<void>;
  writeTaskState(root: string, session: SessionInfo, task: SessionTaskState): Promise<void>;
  appendEvent(root: string, session: SessionInfo, event: SessionEventRecord): Promise<void>;
  appendLog(root: string, session: SessionInfo, log: SessionLogRecord): Promise<void>;
  appendArtifact(root: string, session: SessionInfo, artifact: ArtifactReference): Promise<void>;
  writeCheckpoint(root: string, session: SessionInfo, checkpoint: CheckpointReference, payload: unknown, markdown?: string): Promise<void>;
  restoreOriginalContext(root: string, session: SessionInfo): Promise<void>;
}

export class SessionPersistenceService {
  public constructor(private readonly store: SessionStore) { }

  public load(root: string, session: SessionInfo): Promise<SessionSnapshot> {
    return this.store.load(root, session);
  }

  public recoverInterruptedTasks(root: string, session: SessionInfo): Promise<void> {
    return this.store.recoverInterruptedTasks(root, session);
  }

  public appendMessage(root: string, session: SessionInfo, message: ChatMessage): Promise<void> {
    return this.store.appendMessage(root, session, message);
  }

  public saveConfig(root: string, session: SessionInfo, config: ModelConfig, extra: Record<string, unknown> = {}): Promise<void> {
    const sanitized = sanitizeConfig(config);
    return this.store.writeConfig(root, session, { ...sanitized, ...extra });
  }

  public updateTask(root: string, session: SessionInfo, task: SessionTaskState): Promise<void> {
    return this.store.writeTaskState(root, session, task);
  }

  public recordEvent(root: string, session: SessionInfo, event: SessionEventRecord): Promise<void> {
    return this.store.appendEvent(root, session, event);
  }

  public recordLog(root: string, session: SessionInfo, log: SessionLogRecord): Promise<void> {
    return this.store.appendLog(root, session, log);
  }

  public recordArtifact(root: string, session: SessionInfo, artifact: ArtifactReference): Promise<void> {
    return this.store.appendArtifact(root, session, artifact);
  }

  public writeCheckpoint(root: string, session: SessionInfo, checkpoint: CheckpointReference, payload: unknown, markdown?: string): Promise<void> {
    return this.store.writeCheckpoint(root, session, checkpoint, payload, markdown);
  }

  public restoreOriginalContext(root: string, session: SessionInfo): Promise<void> {
    return this.store.restoreOriginalContext(root, session);
  }
}

function sanitizeConfig(config: ModelConfig): Record<string, unknown> {
  const sanitized: Record<string, unknown> = { ...config };
  delete sanitized.apiKey;
  if (config.headers) {
    const headers = Object.fromEntries(Object.entries(config.headers).filter(([key]) => !isSensitiveHeader(key)));
    sanitized.headers = headers;
  }
  return sanitized;
}

export function taskStatusForModelError(code: string): "stopped" | "failed" {
  return code === "aborted" || code === "cancelled" ? "stopped" : "failed";
}

function isSensitiveHeader(name: string): boolean {
  return /authorization|api[-_]?key|token|secret|cookie|credential|session/i.test(name);
}
