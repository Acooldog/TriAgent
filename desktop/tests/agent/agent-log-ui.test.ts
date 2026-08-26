import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

test("keeps Agent logs in files without exposing a frontend log panel", () => {
  const chat = read("desktop/presentation/renderer/components/LlmChat.tsx");
  const state = read("desktop/presentation/renderer/hooks/useAppState.ts");
  const styles = read("desktop/presentation/renderer/styles.css");
  assert.doesNotMatch(chat, /AgentLogPanel|Agent 日志|agentLogs|showAgentLogs/);
  assert.doesNotMatch(state, /AgentLogEntry|agentLogs|setAgentLogs/);
  assert.doesNotMatch(styles, /llm-agent-log/);
});
