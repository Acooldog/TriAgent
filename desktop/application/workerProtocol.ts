export const WORKER_PROTOCOL_VERSION = "1" as const;

export type WorkerOperation = "ping" | "decrypt";
export type WorkerEventStatus = "running" | "completed" | "failed" | "cancelled";

export interface WorkerErrorPayload {
  code: string;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export interface WorkerStartRequest {
  protocol_version: typeof WORKER_PROTOCOL_VERSION;
  command: "start";
  request_id: string;
  task_id: string;
  operation: WorkerOperation;
  payload: Record<string, unknown>;
}

export interface WorkerCancelRequest {
  protocol_version: typeof WORKER_PROTOCOL_VERSION;
  command: "cancel";
  request_id: string;
  task_id: string;
}

export interface WorkerEvent {
  protocol_version: typeof WORKER_PROTOCOL_VERSION;
  request_id: string;
  task_id: string;
  event_type: string;
  status: WorkerEventStatus;
  payload: Record<string, unknown>;
  error: WorkerErrorPayload | null;
  emitted_at: string;
}

export class WorkerProtocolError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WorkerProtocolError";
  }
}

export function parseWorkerEvent(line: string): WorkerEvent {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    throw new WorkerProtocolError("worker output is not valid JSON");
  }
  if (!isRecord(value) || value.protocol_version !== WORKER_PROTOCOL_VERSION) throw new WorkerProtocolError("worker output protocol version is incompatible");
  if (!isNonEmptyString(value.request_id) || !isNonEmptyString(value.task_id) || !isNonEmptyString(value.event_type) || !isNonEmptyString(value.emitted_at)) throw new WorkerProtocolError("worker output is missing required fields");
  if (!["running", "completed", "failed", "cancelled"].includes(String(value.status))) throw new WorkerProtocolError("worker output status is invalid");
  if (!isRecord(value.payload) || (value.error !== null && !isRecord(value.error))) throw new WorkerProtocolError("worker output payload or error is invalid");
  return value as unknown as WorkerEvent;
}

export function buildCancelRequest(request: Pick<WorkerStartRequest, "request_id" | "task_id">): WorkerCancelRequest {
  return { protocol_version: WORKER_PROTOCOL_VERSION, command: "cancel", request_id: request.request_id, task_id: request.task_id };
}

export function isTerminalWorkerEvent(event: WorkerEvent): boolean {
  return event.event_type === "worker_finished" || event.status === "failed" || event.status === "cancelled";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
