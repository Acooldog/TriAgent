import assert from "node:assert/strict";
import { test } from "node:test";
import { DiagnosticsService, ErrorSearchService, redactDiagnosticText, type DiagnosticGateway } from "../../application/diagnostics";
import { DEFAULT_EXECUTION_LIMITS, ExecutionBudget, ExecutionBudgetError } from "../../application/settings/executionBudget";
import { PermissionPolicy, PermissionPolicyError } from "../../application/settings/permissionPolicy";

test("enforces restricted, standard approval and full access modes", async () => {
  let approvals = 0;
  const policy = new PermissionPolicy({ requestApproval: async () => { approvals += 1; return true; } });
  await policy.authorize({ mode: "restricted", operation: "built-in", title: "检查", detail: "只读检查" });
  await assert.rejects(policy.authorize({ mode: "restricted", operation: "command", title: "命令", detail: "执行命令" }), (error: unknown) => error instanceof PermissionPolicyError && error.code === "permission-denied");
  await policy.authorize({ mode: "standard", operation: "command", title: "命令", detail: "执行命令" });
  await policy.authorize({ mode: "full", operation: "file-write", title: "写入", detail: "写入文件" });
  assert.equal(approvals, 1);
  await assert.rejects(policy.authorize({ mode: "full", operation: "network", networkEnabled: false, title: "联网", detail: "访问网络" }), (error: unknown) => error instanceof PermissionPolicyError && error.code === "network-disabled");
});

test("stops immediately on task budgets, repeated errors and timeout", () => {
  let now = 0;
  const budget = new ExecutionBudget({ ...DEFAULT_EXECUTION_LIMITS, maxModelTurns: 1, maxToolCalls: 1, totalTimeoutMs: 10 }, () => now);
  budget.recordModelTurn();
  assert.throws(() => budget.recordModelTurn(), (error: unknown) => error instanceof ExecutionBudgetError && error.code === "model-budget-exhausted");
  const repeated = new ExecutionBudget();
  repeated.recordError("failed", "same");
  assert.throws(() => repeated.recordError("failed", "same"), (error: unknown) => error instanceof ExecutionBudgetError && error.code === "repeated-error");
  const timed = new ExecutionBudget({ ...DEFAULT_EXECUTION_LIMITS, totalTimeoutMs: 10 }, () => now);
  now = 10;
  assert.throws(() => timed.assertActive(), (error: unknown) => error instanceof ExecutionBudgetError && error.code === "task-timeout");
});

test("limits each step to two retries and each task to sixteen tool calls", () => {
  const retries = new ExecutionBudget();
  retries.recordRetry("step-1");
  retries.recordRetry("step-1");
  assert.throws(() => retries.recordRetry("step-1"), (error: unknown) => error instanceof ExecutionBudgetError && error.code === "retry-budget-exhausted");
  const tools = new ExecutionBudget();
  tools.recordToolCalls(16);
  assert.throws(() => tools.recordToolCalls(), (error: unknown) => error instanceof ExecutionBudgetError && error.code === "tool-budget-exhausted");
});

test("classifies health checks and redacts diagnostic details", async () => {
  const gateway: DiagnosticGateway = {
    checkFfmpeg: async () => ({ status: "healthy", summary: "FFmpeg 正常", recoverySuggestion: "无需处理" }),
    checkModel: async () => { throw new Error("C:\\Users\\name\\secret token=abc"); },
    checkWorker: async () => ({ status: "healthy", summary: "worker 正常", recoverySuggestion: "无需处理" }),
    checkProviders: async () => ({ status: "warning", summary: "Provider 未配置", recoverySuggestion: "请配置" }),
  };
  const report = await new DiagnosticsService(gateway, () => new Date("2026-08-23T00:00:00.000Z")).run({ networkEnabled: false, sessionReady: true, logsLocation: "O:\\Data\\logs.jsonl" });
  assert.equal(report.items.length, 5);
  assert.equal(report.items.find((item) => item.category === "model")?.status, "error");
  assert.doesNotMatch(report.items.find((item) => item.category === "model")!.summary, /Users|abc/);
  assert.equal(redactDiagnosticText("Bearer secret-value"), "Bearer [已脱敏]");
});

test("error search sends only a redacted summary and stops after no results", async () => {
  let sent = "";
  const permissions = new PermissionPolicy({ requestApproval: async () => true });
  const service = new ErrorSearchService({ search: async (summary) => { sent = summary; return []; } }, permissions);
  const result = await service.search({ category: "worker", summary: "C:\\Users\\name\\file token=abc" }, "standard", true);
  assert.equal(result.status, "stopped");
  assert.doesNotMatch(sent, /Users|abc/);
});
