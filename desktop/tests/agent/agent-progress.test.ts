import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { PythonWorkerClient } from "../infrastructure/pythonWorker";

const python = process.env.TRIMUSIC_PYTHON ?? path.join(process.cwd(), ".venv", "Scripts", "python.exe");
const pythonEnv = { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };

test("builds concise Chinese action messages before agent work", () => {
  const script = [
    "import json",
    "from src.Infrastructure.agent_progress import build_initial_action_message, build_tool_action_message",
    "print(json.dumps({",
    "  'initial': build_initial_action_message('请把目录里的 kgma 解密到输出目录'),",
    "  'scan': build_tool_action_message('scan_files'),",
    "  'decrypt': build_tool_action_message('decrypt_kugou'),",
    "}, ensure_ascii=False))",
  ].join("\n");
  const result = JSON.parse(execFileSync(python, ["-c", script], { cwd: process.cwd(), encoding: "utf8", env: pythonEnv })) as Record<string, string>;
  assert.match(result.initial, /先.*路径.*扫描.*解密/);
  assert.match(result.scan, /扫描.*目录/);
  assert.match(result.decrypt, /开始解密/);
});

test("adds a fallback action message before a silent tool call", () => {
  const script = [
    "import json",
    "import src.Infrastructure.agent_executor as executor",
    "events = []",
    "class AIMessage:",
    "    content = ''",
    "    tool_calls = [{'name': 'scan_files', 'args': {'directory': 'D:/music'}, 'id': 'call-1'}]",
    "emitter = executor.AgentEventEmitter(lambda name, payload: events.append({'name': name, 'payload': payload}))",
    "executor._handle_stream_message(AIMessage(), {}, emitter, {}, [])",
    "print(json.dumps(events, ensure_ascii=False))",
  ].join("\n");
  const events = JSON.parse(execFileSync(python, ["-c", script], { cwd: process.cwd(), encoding: "utf8", env: pythonEnv })) as Array<{ name: string; payload: Record<string, unknown> }>;
  const actionIndex = events.findIndex((event) => event.name === "agent_message");
  const toolIndex = events.findIndex((event) => event.name === "agent_tool_call");
  assert.ok(actionIndex >= 0);
  assert.ok(toolIndex > actionIndex);
});

test("emits the initial action message before runtime setup", () => {
  const script = [
    "import json",
    "import src.Infrastructure.agent_executor as executor",
    "events = []",
    "executor._LANGCHAIN_AVAILABLE = False",
    "executor.run_agent('请解密目录里的 kgma 文件', {}, lambda name, payload: events.append({'name': name, 'payload': payload}))",
    "print(json.dumps(events, ensure_ascii=False))",
  ].join("\n");
  const events = JSON.parse(execFileSync(python, ["-c", script], { cwd: process.cwd(), encoding: "utf8", env: pythonEnv })) as Array<{ name: string; payload: Record<string, unknown> }>;
  const startedIndex = events.findIndex((event) => event.name === "agent_started");
  const actionIndex = events.findIndex((event) => event.name === "agent_message");
  const errorIndex = events.findIndex((event) => event.name === "agent_error");
  assert.ok(startedIndex >= 0);
  assert.ok(actionIndex > startedIndex);
  assert.ok(errorIndex > actionIndex);
});

test("worker publishes the action message before loading the full agent runtime", async () => {
  const events: Array<{ event_type: string; payload: Record<string, unknown> }> = [];
  const client = new PythonWorkerClient({
    workerScript: path.join(process.cwd(), "desktop", "infrastructure", "publicWorker.py"),
    pythonExecutable: python,
    cwd: process.cwd(),
    defaultTimeoutMs: 10000,
  });
  const handle = client.start({
    protocol_version: "1",
    command: "start",
    request_id: "request-progress",
    task_id: "task-progress",
    operation: "agent",
    payload: { message: "请解密目录里的 kgma 文件", model_config: { model: "test", base_url: "https://example.invalid/v1" }, max_iterations: 1 },
  }, (event) => events.push(event));
  const result = await handle.completion;
  const actionIndex = events.findIndex((event) => event.event_type === "agent_message");
  const importIndex = events.findIndex((event) => event.event_type === "agent_log" && String(event.payload.message).includes("步骤 1/3"));
  assert.equal(result.status, "failed");
  assert.ok(actionIndex >= 0);
  assert.ok(importIndex > actionIndex);
});
