import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import path from "node:path";
import { test } from "node:test";
import { parseWorkerEvent } from "../application/workerProtocol";
import { PythonWorkerClient, WorkerBridgeError, type WorkerProcess } from "../infrastructure/pythonWorker";

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
  const client = new PythonWorkerClient({ workerScript: path.join(process.cwd(), "src", "Presentation", "worker.py"), defaultTimeoutMs: 5000 });
  const handle = client.start({ protocol_version: "1", command: "start", request_id: "request-ping", task_id: "task-ping", operation: "ping", payload: {} }, () => undefined);
  const result = await handle.completion;
  assert.equal(result.status, "completed");
  assert.equal(result.resultCode, 0);
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
