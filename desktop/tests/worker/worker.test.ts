import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import path from "node:path";
import { test } from "node:test";
import { parseWorkerEvent } from "../../application/worker/workerProtocol";
import { PythonWorkerClient, WorkerBridgeError, type WorkerProcess } from "../../infrastructure/workers/pythonWorker";

class FakeWorkerProcess extends EventEmitter implements WorkerProcess {
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public killed = false;

  public kill(): boolean {
    this.killed = true;
    this.emit("close", null, "SIGTERM");
    return true;
  }
}

function eventLine(taskId = "task-1", requestId = "request-1", status = "completed", payload: Record<string, unknown> = { result_code: 0 }): string {
  return `${JSON.stringify({ protocol_version: "1", request_id: requestId, task_id: taskId, event_type: "worker_finished", status, payload, error: null, emitted_at: new Date().toISOString() })}\n`;
}

test("parses versioned worker event and rejects malformed output", () => {
  const event = parseWorkerEvent(eventLine());
  assert.equal(event.task_id, "task-1");
  assert.throws(() => parseWorkerEvent("not-json"), /valid JSON/);
});

test("runs the real Python worker ping operation", async () => {
  const client = new PythonWorkerClient({ workerScript: path.join(process.cwd(), "desktop", "infrastructure", "workers", "publicWorker.py"), defaultTimeoutMs: 5000 });
  const handle = client.start({ protocol_version: "1", command: "start", request_id: "request-ping", task_id: "task-ping", operation: "ping", payload: {} }, () => undefined);
  const result = await handle.completion;
  assert.equal(result.status, "completed");
  assert.equal(result.resultCode, 0);
  assert.equal(result.event.payload.message, "Python worker 已就绪。");
});

test("forces UTF-8 for the Python worker process", async () => {
  const process = new FakeWorkerProcess();
  let options: Record<string, unknown> | undefined;
  const client = new PythonWorkerClient({
    workerScript: "unused",
    spawnWorker: (_command, _args, spawnOptions) => { options = spawnOptions as Record<string, unknown>; return process; },
    defaultTimeoutMs: 1000,
  });
  const handle = client.start({ protocol_version: "1", command: "start", request_id: "request-env", task_id: "task-env", operation: "ping", payload: {} }, () => undefined);
  process.stdout.write(eventLine("task-env", "request-env"));
  await handle.completion;
  const env = options?.env as Record<string, string>;
  assert.equal(env.PYTHONUTF8, "1");
  assert.equal(env.PYTHONIOENCODING, "utf-8");
});

test("normalizes protocol errors and timeouts", async () => {
  const malformed = new FakeWorkerProcess();
  const malformedClient = new PythonWorkerClient({ workerScript: "unused", spawnWorker: () => malformed, defaultTimeoutMs: 1000 });
  const malformedHandle = malformedClient.start({ protocol_version: "1", command: "start", request_id: "request-bad", task_id: "task-bad", operation: "ping", payload: {} }, () => undefined);
  malformed.stdout.write("bad-output\n");
  await assert.rejects(malformedHandle.completion, (error: unknown) => error instanceof WorkerBridgeError && error.code === "worker-protocol-error");

  const idle = new FakeWorkerProcess();
  const timeoutClient = new PythonWorkerClient({ workerScript: "unused", spawnWorker: () => idle, defaultTimeoutMs: 20 });
  const timeoutHandle = timeoutClient.start({ protocol_version: "1", command: "start", request_id: "request-timeout", task_id: "task-timeout", operation: "ping", payload: {} }, () => undefined);
  await assert.rejects(timeoutHandle.completion, (error: unknown) => error instanceof WorkerBridgeError && error.code === "worker-timeout");
});

test("preserves UTF-8 worker events split across byte chunks", async () => {
  const process = new FakeWorkerProcess();
  const events: ReturnType<typeof parseWorkerEvent>[] = [];
  const client = new PythonWorkerClient({ workerScript: "unused", spawnWorker: () => process, defaultTimeoutMs: 1000 });
  const handle = client.start({ protocol_version: "1", command: "start", request_id: "request-utf8", task_id: "task-utf8", operation: "agent", payload: {} }, (event) => events.push(event));
  const line = Buffer.from(`${JSON.stringify({ protocol_version: "1", request_id: "request-utf8", task_id: "task-utf8", event_type: "agent_log", status: "running", payload: { message: "中文进度" }, error: null, emitted_at: new Date().toISOString() })}\n`, "utf8");
  const splitAt = line.indexOf(Buffer.from("中", "utf8")) + 1;
  process.stdout.write(line.subarray(0, splitAt));
  process.stdout.write(line.subarray(splitAt));
  process.stdout.write(eventLine("task-utf8", "request-utf8"));
  await handle.completion;
  assert.equal(events[0]?.payload.message, "中文进度");
});

test("buffers UTF-8 stderr by complete lines", async () => {
  const process = new FakeWorkerProcess();
  const events: ReturnType<typeof parseWorkerEvent>[] = [];
  const client = new PythonWorkerClient({ workerScript: "unused", spawnWorker: () => process, defaultTimeoutMs: 1000 });
  const handle = client.start({ protocol_version: "1", command: "start", request_id: "request-stderr", task_id: "task-stderr", operation: "agent", payload: {} }, (event) => events.push(event));
  const line = Buffer.from("中文错误\n", "utf8");
  const splitAt = line.indexOf(Buffer.from("中", "utf8")) + 1;
  process.stderr.write(line.subarray(0, splitAt));
  process.stderr.write(line.subarray(splitAt));
  process.stdout.write(eventLine("task-stderr", "request-stderr"));
  await handle.completion;
  const logs = events.filter((event) => event.event_type === "agent_log");
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.payload.message, "[stderr] 中文错误");
});

test("sends a cancel command and terminates an active worker", async () => {
  const process = new FakeWorkerProcess();
  const client = new PythonWorkerClient({ workerScript: "unused", spawnWorker: () => process, defaultTimeoutMs: 1000 });
  const handle = client.start({ protocol_version: "1", command: "start", request_id: "request-cancel", task_id: "task-cancel", operation: "ping", payload: {} }, () => undefined);
  const completion = assert.rejects(handle.completion, (error: unknown) => error instanceof WorkerBridgeError && error.code === "worker-cancelled");
  assert.equal(client.cancel("task-cancel"), true);
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(process.killed, true);
  await completion;
});
