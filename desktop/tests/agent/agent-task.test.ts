import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentTaskService } from "../../application/agent/agentTaskService";
import { MVP_CAPABILITY_ID, MVP_PROVIDER_ID } from "../../infrastructure/providers/constants";
import { FakeMvpProviderGateway } from "../../infrastructure/providers/fakeMvpProviderGateway";

test("creates a structured Chinese decrypt plan from a natural language request", () => {
  const service = new AgentTaskService(undefined as never, undefined as never, undefined as never);
  const plan = service.createPlan("请解密本地文件，输入 D:\\Music\\sample.kgg，输出 D:\\Music\\decoded");
  assert.equal(plan.steps[0]?.providerId, MVP_PROVIDER_ID);
  assert.equal(plan.steps[0]?.capabilityId, MVP_CAPABILITY_ID);
  assert.deepEqual(plan.steps[0]?.input, { platform: "kugou", inputPath: "D:\\Music\\sample.kgg", outputDir: "D:\\Music\\decoded", recursive: false });
});

test("fake Provider completes the same event and output contract used by the private slice", async () => {
  const gateway = new FakeMvpProviderGateway();
  const events: string[] = [];
  const result = await gateway.invoke({ requestId: "request", taskId: "task", providerId: MVP_PROVIDER_ID, capabilityId: MVP_CAPABILITY_ID, permissionMode: "standard", input: { platform: "kugou", inputPath: "D:\\Music\\sample.kgg", outputDir: "D:\\Music\\decoded" }, timeoutMs: 1000 }, (event) => events.push(event.event_type), new AbortController().signal);
  assert.deepEqual(events, ["started", "progress", "completed"]);
  assert.deepEqual(result.output, { success: true, outputPath: "D:\\Music\\decoded/sample.m4a", format: "m4a" });
});
