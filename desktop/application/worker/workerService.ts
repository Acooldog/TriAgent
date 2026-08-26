import { randomUUID } from "node:crypto";
import { WORKER_PROTOCOL_VERSION, type WorkerEvent, type WorkerOperation, type WorkerStartRequest } from "../workerProtocol";

export interface WorkerCompletion {
  status: "completed" | "failed" | "cancelled";
  resultCode?: number;
  event: WorkerEvent;
}

export interface WorkerRunHandle {
  requestId: string;
  taskId: string;
  completion: Promise<WorkerCompletion>;
  cancel(): void;
}

export interface WorkerRunner {
  start(request: WorkerStartRequest, onEvent: (event: WorkerEvent) => void, timeoutMs?: number): WorkerRunHandle;
  cancel(taskId: string): boolean;
  sendSupplement(taskId: string, text: string): boolean;
  sendAnswer(taskId: string, questionId: string, answer: string): boolean;
}

export interface WorkerTaskOptions {
  taskId?: string;
  requestId?: string;
  timeoutMs?: number;
}

export class WorkerService {
  public constructor(private readonly runner: WorkerRunner, private readonly createId: () => string = randomUUID) { }

  public start(operation: WorkerOperation, payload: Record<string, unknown>, onEvent: (event: WorkerEvent) => void, options: WorkerTaskOptions = {}): WorkerRunHandle {
    const taskId = options.taskId ?? this.createId();
    const requestId = options.requestId ?? this.createId();
    const request: WorkerStartRequest = {
      protocol_version: WORKER_PROTOCOL_VERSION,
      command: "start",
      request_id: requestId,
      task_id: taskId,
      operation,
      payload,
    };
    return this.runner.start(request, onEvent, options.timeoutMs);
  }

  public cancel(taskId: string): boolean {
    return this.runner.cancel(taskId);
  }

  public sendSupplement(taskId: string, text: string): boolean {
    return this.runner.sendSupplement(taskId, text);
  }

  public sendAnswer(taskId: string, questionId: string, answer: string): boolean {
    return this.runner.sendAnswer(taskId, questionId, answer);
  }
}
