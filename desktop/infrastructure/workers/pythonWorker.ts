import { spawn, type SpawnOptions } from "node:child_process";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { buildAnswerRequest, buildCancelRequest, buildSupplementRequest, isTerminalWorkerEvent, parseWorkerEvent, type WorkerEvent, type WorkerStartRequest } from "../../application/worker/workerProtocol";
import type { WorkerCompletion, WorkerRunHandle, WorkerRunner } from "../../application/worker/workerService";
import { debugError, debugInfo } from "../logging/debugLogger";

export type WorkerBridgeErrorCode = "worker-start-failed" | "worker-protocol-error" | "worker-cancelled" | "worker-timeout" | "worker-exited";

export class WorkerBridgeError extends Error {
  public constructor(public readonly code: WorkerBridgeErrorCode, message: string) {
    super(message);
    this.name = "WorkerBridgeError";
  }
}

export interface WorkerProcess {
  stdin: { write(chunk: string): boolean };
  stdout: Pick<Readable, "on">;
  stderr: Pick<Readable, "on">;
  on(event: "error" | "close", listener: (...args: any[]) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export type WorkerSpawner = (command: string, args: string[], options: SpawnOptions) => WorkerProcess;

export interface PythonWorkerOptions {
  workerScript: string;
  pythonExecutable?: string;
  cwd?: string;
  defaultTimeoutMs?: number;
  cancelGraceMs?: number;
  spawnWorker?: WorkerSpawner;
}

interface ActiveRun {
  request: WorkerStartRequest;
  process: WorkerProcess;
  resolve: (result: WorkerCompletion) => void;
  reject: (error: WorkerBridgeError) => void;
  settled: boolean;
  cancellationRequested: boolean;
  buffer: string;
  stderrBuffer: string;
  stdoutDecoder: StringDecoder;
  stderrDecoder: StringDecoder;
  timeout: NodeJS.Timeout;
}

export class PythonWorkerClient implements WorkerRunner {
  private readonly active = new Map<string, ActiveRun>();
  private readonly spawnWorker: WorkerSpawner;
  private readonly pythonExecutable: string;
  private readonly defaultTimeoutMs: number;
  private readonly cancelGraceMs: number;

  public constructor(private readonly options: PythonWorkerOptions) {
    this.spawnWorker = options.spawnWorker ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions) as unknown as WorkerProcess);
    this.pythonExecutable = options.pythonExecutable ?? process.env.TRIMUSIC_PYTHON ?? "python";
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 15 * 60 * 1000;
    this.cancelGraceMs = options.cancelGraceMs ?? 750;
  }

  public start(request: WorkerStartRequest, onEvent: (event: WorkerEvent) => void, timeoutMs = this.defaultTimeoutMs): WorkerRunHandle {
    debugInfo("worker", "start", { operation: request.operation, requestId: request.request_id, taskId: request.task_id, timeoutMs, pythonConfigured: Boolean(this.pythonExecutable), workerScript: this.options.workerScript });
    if (this.active.has(request.task_id)) throw new WorkerBridgeError("worker-start-failed", "该 Agent 任务已有一个活动 worker。");
    let processHandle: WorkerProcess;
    try {
      const spawnEnv = { ...process.env };
      const spawnOpts: SpawnOptions = { cwd: this.options.cwd, stdio: ["pipe", "pipe", "pipe"] };
      if (this.pythonExecutable) {
        spawnEnv.PYTHONUNBUFFERED = "1";
        spawnEnv.PYTHONUTF8 = "1";
        spawnEnv.PYTHONIOENCODING = "utf-8";
        processHandle = this.spawnWorker(this.pythonExecutable, [this.options.workerScript], { ...spawnOpts, env: spawnEnv });
      } else {
        const ext = process.platform === "win32" ? ".exe" : "";
        const command = this.options.workerScript.endsWith(ext)
          ? this.options.workerScript
          : this.options.workerScript + ext;
        processHandle = this.spawnWorker(command, [], { ...spawnOpts, env: spawnEnv });
      }
    } catch (error) {
      throw new WorkerBridgeError("worker-start-failed", error instanceof Error ? error.message : "无法启动 Python worker。");
    }
    let resolveCompletion!: (result: WorkerCompletion) => void;
    let rejectCompletion!: (error: WorkerBridgeError) => void;
    const completion = new Promise<WorkerCompletion>((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
    const active: ActiveRun = { request, process: processHandle, resolve: resolveCompletion, reject: rejectCompletion, settled: false, cancellationRequested: false, buffer: "", stderrBuffer: "", stdoutDecoder: new StringDecoder("utf8"), stderrDecoder: new StringDecoder("utf8"), timeout: setTimeout(() => undefined, 2 ** 31 - 1) };
    clearTimeout(active.timeout);
    active.timeout = setTimeout(() => this.fail(active, "worker-timeout", "Python worker 超时，任务已停止。", true), timeoutMs);
    this.active.set(request.task_id, active);
    processHandle.stdout.on("data", (chunk: Buffer | string) => this.consumeOutput(active, chunk, onEvent));
    processHandle.stderr.on("data", (chunk: Buffer | string) => this.consumeStderr(active, chunk, onEvent));
    processHandle.on("error", (error: Error) => { debugError("worker", "process-error", error, { requestId: request.request_id, taskId: request.task_id }); this.fail(active, "worker-start-failed", error.message, true); });
    processHandle.on("close", (code: number | null) => {
      if (!active.settled) this.flushStderr(active, onEvent);
      if (!active.settled) this.fail(active, active.cancellationRequested ? "worker-cancelled" : "worker-exited", active.cancellationRequested ? "Python worker 已取消。" : `Python worker 已退出（${code ?? "未知"}）。`, false);
    });
    try { processHandle.stdin.write(`${JSON.stringify(request)}\n`); } catch (error) { this.fail(active, "worker-start-failed", error instanceof Error ? error.message : "无法写入 worker 请求。", true); }
    return { requestId: request.request_id, taskId: request.task_id, completion, cancel: () => { this.cancel(request.task_id); } };
  }

  public cancel(taskId: string): boolean {
    debugInfo("worker", "cancel-request", { taskId });
    const active = this.active.get(taskId);
    if (!active || active.settled) return false;
    active.cancellationRequested = true;
    try { active.process.stdin.write(`${JSON.stringify(buildCancelRequest(active.request))}\n`); } catch { this.kill(active); }
    setTimeout(() => { if (!active.settled) this.kill(active); }, this.cancelGraceMs);
    return true;
  }

  public sendSupplement(taskId: string, text: string): boolean {
    debugInfo("worker", "supplement-request", { taskId, textPreview: text.slice(0, 80) });
    const active = this.active.get(taskId);
    if (!active || active.settled) return false;
    try { active.process.stdin.write(`${JSON.stringify(buildSupplementRequest(active.request, text))}\n`); } catch (error) { debugError("worker", "supplement-write-failed", error instanceof Error ? error : undefined, { taskId }); return false; }
    return true;
  }

  public sendAnswer(taskId: string, questionId: string, answer: string): boolean {
    debugInfo("worker", "answer-request", { taskId, questionId, answerPreview: answer.slice(0, 80) });
    const active = this.active.get(taskId);
    if (!active || active.settled) return false;
    try { active.process.stdin.write(`${JSON.stringify(buildAnswerRequest(active.request, questionId, answer))}\n`); } catch (error) { debugError("worker", "answer-write-failed", error instanceof Error ? error : undefined, { taskId, questionId }); return false; }
    return true;
  }

  public activeTaskIds(): string[] { return [...this.active.keys()]; }

  private consumeOutput(active: ActiveRun, chunk: Buffer | string, onEvent: (event: WorkerEvent) => void): void {
    active.buffer += typeof chunk === "string" ? chunk : active.stdoutDecoder.write(chunk);
    let newline = active.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = active.buffer.slice(0, newline).trim();
      active.buffer = active.buffer.slice(newline + 1);
      if (line) {
        try {
          const event = parseWorkerEvent(line);
          if (event.request_id !== active.request.request_id || event.task_id !== active.request.task_id) throw new Error("worker 输出的任务标识不匹配。");
          debugInfo("worker", "event", { requestId: event.request_id, taskId: event.task_id, eventType: event.event_type, status: event.status });
          try { onEvent(event); } catch { debugInfo("worker", "observer-error", { requestId: event.request_id, taskId: event.task_id }); }
          if (isTerminalWorkerEvent(event)) this.complete(active, event);
        } catch (error) {
          debugError("worker", "protocol-error", error, { requestId: active.request.request_id, taskId: active.request.task_id });
          this.fail(active, "worker-protocol-error", error instanceof Error ? error.message : "worker 输出协议无效。", true);
          return;
        }
      }
      newline = active.buffer.indexOf("\n");
    }
  }

  private consumeStderr(active: ActiveRun, chunk: Buffer | string, onEvent: (event: WorkerEvent) => void): void {
    active.stderrBuffer += typeof chunk === "string" ? chunk : active.stderrDecoder.write(chunk);
    let newline = active.stderrBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = active.stderrBuffer.slice(0, newline).trim();
      active.stderrBuffer = active.stderrBuffer.slice(newline + 1);
      if (line) this.publishStderrLine(active, line, onEvent);
      newline = active.stderrBuffer.indexOf("\n");
    }
  }

  private flushStderr(active: ActiveRun, onEvent: (event: WorkerEvent) => void): void {
    active.stderrBuffer += active.stderrDecoder.end();
    const line = active.stderrBuffer.trim();
    active.stderrBuffer = "";
    if (line) this.publishStderrLine(active, line, onEvent);
  }

  private publishStderrLine(active: ActiveRun, line: string, onEvent: (event: WorkerEvent) => void): void {
    debugInfo("worker", "stderr", { requestId: active.request.request_id, taskId: active.request.task_id, output: line.slice(0, 500) });
    try {
      onEvent({
        protocol_version: "1",
        request_id: active.request.request_id,
        task_id: active.request.task_id,
        event_type: "agent_log",
        status: "running",
        payload: { level: "error", message: `[stderr] ${line.slice(0, 300)}`, timestamp: new Date().toISOString() },
        error: null,
        emitted_at: new Date().toISOString(),
      });
    } catch { /* ignore forwarding errors */ }
  }

  private complete(active: ActiveRun, event: WorkerEvent): void {
    if (active.settled) return;
    active.settled = true;
    clearTimeout(active.timeout);
    this.active.delete(active.request.task_id);
    debugInfo("worker", "complete", { requestId: active.request.request_id, taskId: active.request.task_id, status: event.status });
    const rawCode = event.payload.result_code;
    active.resolve({ status: event.status === "cancelled" ? "cancelled" : event.status === "failed" ? "failed" : "completed", resultCode: typeof rawCode === "number" ? rawCode : undefined, event });
  }

  private fail(active: ActiveRun, code: WorkerBridgeErrorCode, message: string, kill: boolean): void {
    if (active.settled) return;
    active.settled = true;
    clearTimeout(active.timeout);
    this.active.delete(active.request.task_id);
    debugInfo("worker", "fail", { requestId: active.request.request_id, taskId: active.request.task_id, code, kill });
    if (kill) this.kill(active);
    active.reject(new WorkerBridgeError(code, message));
  }

  private kill(active: ActiveRun): void { try { active.process.kill("SIGTERM"); } catch { /* Process may already have exited. */ } }
}
