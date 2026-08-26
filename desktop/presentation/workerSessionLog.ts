import type { SessionLogRecord } from "../application/agent/sessionPersistence";
import type { WorkerEvent } from "../application/worker/workerProtocol";

const SENSITIVE_TEXT = /(bearer\s+|authorization\s*[:=]\s*|api[-_]?key\s*[:=]\s*|token\s*[:=]\s*|secret\s*[:=]\s*|cookie\s*[:=]\s*)\S+/gi;
const LEVELS = new Set<SessionLogRecord["level"]>(["debug", "info", "warn", "error"]);

export function createWorkerSessionLog(event: WorkerEvent): SessionLogRecord {
  const rawLevel = String(event.payload.level ?? "info") as SessionLogRecord["level"];
  const level = event.event_type === "agent_log" && LEVELS.has(rawLevel) ? rawLevel : event.status === "failed" ? "error" : "info";
  const rawMessage = event.event_type === "agent_log" ? String(event.payload.message ?? "agent_log") : event.event_type;
  return {
    emittedAt: event.emitted_at,
    level,
    message: rawMessage.replace(SENSITIVE_TEXT, "$1[已脱敏]"),
    context: { category: "worker", eventType: event.event_type, taskId: event.task_id, requestId: event.request_id },
  };
}
