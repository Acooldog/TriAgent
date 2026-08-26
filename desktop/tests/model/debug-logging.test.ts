import assert from "node:assert/strict";
import { test } from "node:test";
import { debugError, debugInfo } from "../../infrastructure/logging/debugLogger";

test("调试日志记录行为但脱敏凭据", () => {
  const originalInfo = console.info;
  const originalError = console.error;
  const entries: string[] = [];
  console.info = ((...args: unknown[]) => entries.push(JSON.stringify(args))) as typeof console.info;
  console.error = ((...args: unknown[]) => entries.push(JSON.stringify(args))) as typeof console.error;
  try {
    debugInfo("test", "request", { apiKey: "secret-value", token: "token-value", model: "glm-4.5" });
    debugError("test", "failure", new Error("authorization=secret-value"), { cookie: "cookie-value" });
  } finally { console.info = originalInfo; console.error = originalError; }
  const output = entries.join("\n");
  assert.match(output, /glm-4\.5/);
  assert.doesNotMatch(output, /secret-value|token-value|cookie-value/);
  assert.match(output, /已脱敏/);
});
