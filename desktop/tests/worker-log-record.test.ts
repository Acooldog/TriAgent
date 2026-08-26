import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkerEvent } from "../application/workerProtocol";
import { createWorkerSessionLog } from "../presentation/workerSessionLog";

function event(eventType: string, payload: Record<string, unknown>): WorkerEvent {
  return { protocol_version: "1", request_id: "request-1", task_id: "task-1", event_type: eventType, status: "running", payload, error: null, emitted_at: "2026-08-26T01:00:00.000Z" };
}

test("persists the actual agent log message with credential redaction", () => {
  const log = createWorkerSessionLog(event("agent_log", { level: "warn", message: "连接失败 api_key=secret-value 中文详情" }));
  assert.equal(log.level, "warn");
  assert.match(log.message, /连接失败.*中文详情/);
  assert.doesNotMatch(log.message, /secret-value/);
  assert.match(log.message, /已脱敏/);
  assert.deepEqual(log.context, { category: "worker", eventType: "agent_log", taskId: "task-1", requestId: "request-1" });
});

test("keeps non-log worker events as compact event names", () => {
  const log = createWorkerSessionLog(event("worker_finished", { result_code: 0 }));
  assert.equal(log.level, "info");
  assert.equal(log.message, "worker_finished");
});
