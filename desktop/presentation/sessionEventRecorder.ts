import { randomUUID } from "node:crypto";
import { debugError, debugInfo } from "../infrastructure/logging/debugLogger";
import type { SessionEventRecord, SessionLogRecord, SessionPersistenceService, SessionTaskState } from "../application/agent/sessionPersistence";
import type { SessionInfo } from "../application/workspace/workspaceService";

type TaskContext = { root: string; session: SessionInfo };

export interface SessionEventRecorderOptions {
  sessionPersistence: SessionPersistenceService;
  selectedContext: () => TaskContext | null;
  resolveTaskContext: (taskId: string) => TaskContext | null;
  refreshContext: (context: TaskContext) => Promise<void>;
  getQueue: () => Promise<void>;
  setQueue: (queue: Promise<void>) => void;
  reportPersistenceError: (label: string, message: string) => void;
}

export function createSessionEventRecorder(options: SessionEventRecorderOptions) {
  const enqueuePersistence = (label: string, operation: () => Promise<void>): void => {
    debugInfo("persistence", "enqueue", { label });
    const current = options.getQueue().then(operation);
    options.setQueue(current.catch((error: unknown) => {
      debugError("persistence", "error", error, { label });
      options.reportPersistenceError(label, error instanceof Error ? error.message : "会话持久化失败。");
    }));
  };

  const persistEvent = (category: SessionEventRecord["category"], eventType: string, payload: Record<string, unknown>, details: Pick<SessionEventRecord, "status" | "taskId" | "requestId"> = {}, taskContext?: TaskContext, logRecord?: SessionLogRecord): void => {
    const context = taskContext ?? options.selectedContext();
    if (!context) return;
    const event: SessionEventRecord = { eventId: randomUUID(), emittedAt: new Date().toISOString(), category, eventType, payload, ...details };
    enqueuePersistence(`event:${eventType}`, async () => {
      await options.sessionPersistence.recordEvent(context.root, context.session, event);
      await options.sessionPersistence.recordLog(context.root, context.session, logRecord ?? { emittedAt: event.emittedAt, level: details.status === "failed" ? "error" : "info", message: eventType, context: { category, taskId: details.taskId, requestId: details.requestId } });
      await options.refreshContext(context);
    });
  };

  const persistTask = (taskId: string, status: SessionTaskState["status"], requestId?: string, error?: { code: string; message: string }, taskContext?: TaskContext): void => {
    const context = taskContext ?? options.resolveTaskContext(taskId);
    if (!context) return;
    enqueuePersistence(`task:${taskId}`, async () => {
      const existing = (await options.sessionPersistence.load(context.root, context.session)).tasks.find((task) => task.taskId === taskId);
      const now = new Date().toISOString();
      await options.sessionPersistence.updateTask(context.root, context.session, { taskId, status, startedAt: existing?.startedAt ?? now, updatedAt: now, ...(status !== "running" ? { completedAt: now } : {}), ...(requestId ? { requestId } : existing?.requestId ? { requestId: existing.requestId } : {}), ...(error ? { error } : {}) });
      await options.refreshContext(context);
    });
  };

  return { enqueuePersistence, persistEvent, persistTask };
}
