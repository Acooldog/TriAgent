import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelService } from "../../application/model/modelService";
import { ModelClientError, type ModelClient, type ModelRequest, type ModelResult } from "../../application/model/modelProtocol";
import { ToolProtocolError, ToolRegistry, type ToolManifest } from "../../application/tools/toolProtocol";
import { OpenAiCompatibleClient } from "../../infrastructure/openAiCompatibleClient";

function manifest(): ToolManifest {
  return {
    protocol_version: "1",
    tool_id: "music.scan",
    version: "1.0.0",
    name: "扫描音乐",
    description: "扫描目录中的音乐文件",
    input_schema: { type: "object", required: ["path"], additionalProperties: false, properties: { path: { type: "string" } } },
    capabilities: ["music.scan"],
    permissions: ["standard", "full"],
    events: ["started", "finished"],
    cancellation: true,
    timeout_ms: 10_000,
  };
}

test("uses a generic OpenAI-compatible endpoint and parses GLM-compatible SSE fields", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const toolArguments = JSON.stringify({ path: "D:\\Music" });
  const body = [
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "思考" } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: "你好" } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "music.scan", arguments: toolArguments } }] } }] })}`,
    `data: ${JSON.stringify({ choices: [{ finish_reason: "tool_calls", delta: {} }] })}`,
    "data: [DONE]",
    "",
  ].join("\n");
  const client = new OpenAiCompatibleClient(async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  });
  const events: string[] = [];
  const result = await client.stream({ config: { baseUrl: "https://example.test/v1", model: "any-model", apiKey: "test-key", thinking: "enabled", maxTokens: 4096, temperature: 0.6 }, messages: [{ role: "user", content: "测试" }] }, (event) => events.push(event.type));
  assert.equal(capturedUrl, "https://example.test/v1/chat/completions");
  assert.equal((capturedInit?.headers as Record<string, string>).authorization, "Bearer test-key");
  assert.equal(JSON.parse(String(capturedInit?.body)).thinking.type, "enabled");
  assert.equal(result.text, "你好");
  assert.equal(result.reasoning, "思考");
  assert.equal(result.toolCalls[0]?.name, "music.scan");
  assert.deepEqual(events, ["reasoning_delta", "text_delta", "tool_call_delta", "response_completed"]);
});

test("normalizes missing credentials without exposing a secret", async () => {
  const client = new OpenAiCompatibleClient(async () => { throw new Error("fetch should not run"); });
  await assert.rejects(client.stream({ config: { baseUrl: "https://example.test/v1", model: "any-model" }, messages: [] }, () => undefined), (error: unknown) => error instanceof ModelClientError && error.code === "credential-missing" && !error.message.includes("test-key"));
});

test("classifies connection timeout separately from user cancellation", async () => {
  const client = new OpenAiCompatibleClient(() => new Promise<Response>(() => undefined));
  await assert.rejects(client.stream({ config: { baseUrl: "https://example.test/v1", model: "any-model", apiKey: "test-key", connectTimeoutMs: 10 }, messages: [] }, () => undefined), (error: unknown) => error instanceof ModelClientError && error.code === "connect-timeout" && error.retryable);
});

test("validates tool manifests, schemas, permissions and hot refresh", () => {
  const registry = new ToolRegistry();
  registry.register(manifest());
  assert.deepEqual(registry.openAiDefinitions()[0]?.function, { name: "music.scan", description: "扫描目录中的音乐文件", parameters: manifest().input_schema });
  registry.validate({ toolCallId: "call-1", toolId: "music.scan", arguments: { path: "D:\\Music" }, permissionMode: "standard" });
  assert.throws(() => registry.validate({ toolCallId: "call-1", toolId: "music.scan", arguments: {}, permissionMode: "standard" }), (error: unknown) => error instanceof ToolProtocolError && error.code === "invalid-arguments");
  assert.throws(() => registry.validate({ toolCallId: "call-1", toolId: "music.scan", arguments: { path: "D:\\Music" }, permissionMode: "restricted" }), (error: unknown) => error instanceof ToolProtocolError && error.code === "permission-denied");
  assert.throws(() => registry.validate({ toolCallId: "call-1", toolId: "unknown", arguments: {}, permissionMode: "standard" }), (error: unknown) => error instanceof ToolProtocolError && error.code === "unknown-tool");
  assert.throws(() => registry.refresh([{ ...manifest(), protocol_version: "9" as "1" }]), (error: unknown) => error instanceof ToolProtocolError && error.code === "protocol-version");
});

test("accepts strict JSON fallback only for registered tools", async () => {
  const fakeClient: ModelClient = { stream: async (_request: ModelRequest, onEvent): Promise<ModelResult> => { onEvent({ type: "text_delta", text: '{"name":"music.scan","arguments":{"path":"D:\\\\Music"}}' }); return { text: '{"name":"music.scan","arguments":{"path":"D:\\\\Music"}}', reasoning: "", toolCalls: [], finishReason: "stop" }; } };
  const service = new ModelService(fakeClient, new ToolRegistry());
  const registry = new ToolRegistry();
  registry.register(manifest());
  const accepted = new ModelService(fakeClient, registry);
  const events: string[] = [];
  await accepted.stream({ config: { baseUrl: "https://example.test/v1", model: "any-model", apiKey: "test-key" }, messages: [], permissionMode: "standard", allowJsonFallback: true }, (event) => events.push(event.type));
  assert.deepEqual(events, ["text_delta", "tool_call_accepted"]);
  await assert.rejects(service.stream({ config: { baseUrl: "https://example.test/v1", model: "any-model", apiKey: "test-key" }, messages: [], permissionMode: "standard", allowJsonFallback: true }, () => undefined), (error: unknown) => error instanceof ToolProtocolError && error.code === "unknown-tool");
});
