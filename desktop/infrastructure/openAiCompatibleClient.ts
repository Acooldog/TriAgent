import { ModelClientError, type ModelClient, type ModelEvent, type ModelRequest, type ModelResult, type ToolCall } from "../application/modelProtocol";
import { debugError, debugInfo } from "../application/debugLogger";

export type FetchImplementation = (input: string, init?: RequestInit) => Promise<Response>;

interface ToolCallBuffer { id: string; name: string; arguments: string; }

export class OpenAiCompatibleClient implements ModelClient {
  public constructor(private readonly fetchImpl: FetchImplementation = fetch) {}

  public async stream(request: ModelRequest, onEvent: (event: ModelEvent) => void): Promise<ModelResult> {
    debugInfo("model-client", "request", { model: request.config.model, baseUrl: request.config.baseUrl, messageCount: request.messages.length, stream: request.config.stream !== false, apiKeyConfigured: Boolean(request.config.apiKey) });
    const controller = new AbortController();
    const detach = relayAbort(request.signal, controller);
    const totalTimer = request.config.totalTimeoutMs ? setTimeout(() => controller.abort(new ModelClientError("total-timeout", "模型请求超过总超时限制。", true)), request.config.totalTimeoutMs) : undefined;
    try {
      const response = await withTimeout(this.fetchImpl(resolveEndpoint(request.config.baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${readCredential(request.config)}`, ...request.config.headers },
        body: JSON.stringify(buildRequestBody(request)),
        signal: controller.signal,
      }), request.config.connectTimeoutMs, controller);
      debugInfo("model-client", "response", { status: response.status, ok: response.ok });
      if (!response.ok) throw await httpError(response);
      if (!response.body) throw new ModelClientError("empty-body", "模型响应没有返回内容。", true, response.status);
      return request.config.stream === false ? await parseJsonResponse(response, onEvent) : await parseSseResponse(response.body, request, onEvent, controller);
    } catch (error) {
      if (error instanceof ModelClientError) { debugError("model-client", "client-error", error, { code: error.code }); onEvent({ type: "error", code: error.code, message: error.message, retryable: error.retryable, status: error.status }); throw error; }
      const reason = controller.signal.reason;
      if (reason instanceof ModelClientError) { onEvent({ type: "error", code: reason.code, message: reason.message, retryable: reason.retryable }); throw reason; }
      const aborted = request.signal?.aborted || controller.signal.aborted;
      const normalized = new ModelClientError(aborted ? "aborted" : "network-error", aborted ? "模型请求已取消。" : "模型连接失败。", !aborted);
      debugError("model-client", "network-error", error, { code: normalized.code }); onEvent({ type: "error", code: normalized.code, message: normalized.message, retryable: normalized.retryable });
      throw normalized;
    } finally {
      detach();
      if (totalTimer) clearTimeout(totalTimer);
    }
  }
}

function buildRequestBody(request: ModelRequest): Record<string, unknown> {
  const body: Record<string, unknown> = { model: request.config.model, messages: request.messages, stream: request.config.stream !== false };
  if (request.config.maxTokens !== undefined) body.max_tokens = request.config.maxTokens;
  if (request.config.temperature !== undefined) body.temperature = request.config.temperature;
  if (request.config.thinking) body.thinking = { type: request.config.thinking };
  if (request.tools && request.tools.length > 0) body.tools = request.tools;
  return body;
}

async function parseSseResponse(body: ReadableStream<Uint8Array>, request: ModelRequest, onEvent: (event: ModelEvent) => void, controller: AbortController): Promise<ModelResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const calls = new Map<number, ToolCallBuffer>();
  let text = "";
  let reasoning = "";
  let finishReason: string | null = null;
  let buffer = "";
  let firstChunk = true;
  while (true) {
    const chunk = await readChunk(reader, firstChunk ? request.config.firstByteTimeoutMs : request.config.readTimeoutMs, controller);
    firstChunk = false;
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let payload: Record<string, any>;
      try {
        payload = JSON.parse(data) as Record<string, any>;
      } catch {
        throw new ModelClientError("invalid-response", "模型流式响应不是有效 JSON。", false);
      }
      const choice = payload.choices?.[0];
      const delta = choice?.delta ?? {};
      if (typeof delta.reasoning_content === "string") { reasoning += delta.reasoning_content; onEvent({ type: "reasoning_delta", text: delta.reasoning_content }); }
      if (typeof delta.content === "string") { text += delta.content; onEvent({ type: "text_delta", text: delta.content }); }
      if (Array.isArray(delta.tool_calls)) for (const call of delta.tool_calls) {
        const index = Number(call.index ?? 0);
        const current = calls.get(index) ?? { id: "", name: "", arguments: "" };
        current.id += typeof call.id === "string" ? call.id : "";
        current.name += typeof call.function?.name === "string" ? call.function.name : "";
        current.arguments += typeof call.function?.arguments === "string" ? call.function.arguments : "";
        calls.set(index, current);
        onEvent({ type: "tool_call_delta", index, id: call.id, name: call.function?.name, argumentsDelta: call.function?.arguments });
      }
      if (choice?.finish_reason) { finishReason = String(choice.finish_reason); onEvent({ type: "response_completed", finishReason }); }
    }
  }
  if (buffer.trim().startsWith("data:") && buffer.slice(5).trim() !== "[DONE]") {
    const payload = JSON.parse(buffer.slice(5).trim()) as Record<string, any>;
    const choice = payload.choices?.[0];
    const delta = choice?.delta ?? {};
    if (typeof delta.reasoning_content === "string") { reasoning += delta.reasoning_content; onEvent({ type: "reasoning_delta", text: delta.reasoning_content }); }
    if (typeof delta.content === "string") { text += delta.content; onEvent({ type: "text_delta", text: delta.content }); }
    if (Array.isArray(delta.tool_calls)) for (const call of delta.tool_calls) {
      const index = Number(call.index ?? 0);
      const current = calls.get(index) ?? { id: "", name: "", arguments: "" };
      current.id += typeof call.id === "string" ? call.id : "";
      current.name += typeof call.function?.name === "string" ? call.function.name : "";
      current.arguments += typeof call.function?.arguments === "string" ? call.function.arguments : "";
      calls.set(index, current);
      onEvent({ type: "tool_call_delta", index, id: call.id, name: call.function?.name, argumentsDelta: call.function?.arguments });
    }
    if (choice?.finish_reason) { finishReason = String(choice.finish_reason); onEvent({ type: "response_completed", finishReason }); }
  }
  return { text, reasoning, toolCalls: [...calls.values()].map((call, index) => ({ id: call.id || `tool-call-${index}`, name: call.name, arguments: call.arguments })), finishReason };
}

async function parseJsonResponse(response: Response, onEvent: (event: ModelEvent) => void): Promise<ModelResult> {
  const payload = await response.json() as Record<string, any>;
  const message = payload.choices?.[0]?.message ?? {};
  const text = typeof message.content === "string" ? message.content : "";
  const reasoning = typeof message.reasoning_content === "string" ? message.reasoning_content : "";
  if (reasoning) onEvent({ type: "reasoning_delta", text: reasoning });
  if (text) onEvent({ type: "text_delta", text });
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls.map((call: any, index: number) => ({ id: String(call.id ?? `tool-call-${index}`), name: String(call.function?.name ?? ""), arguments: String(call.function?.arguments ?? "") })) : [];
  for (const call of toolCalls) onEvent({ type: "tool_call_delta", index: toolCalls.indexOf(call), id: call.id, name: call.name, argumentsDelta: call.arguments });
  const finishReason = payload.choices?.[0]?.finish_reason ? String(payload.choices[0].finish_reason) : null;
  onEvent({ type: "response_completed", finishReason });
  return { text, reasoning, toolCalls, finishReason };
}

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs: number | undefined, controller: AbortController): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!timeoutMs) return reader.read();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([reader.read(), new Promise<never>((_, reject) => { timer = setTimeout(() => { const error = new ModelClientError("read-timeout", "模型流式读取超过超时限制。", true); controller.abort(error); reject(error); }, timeoutMs); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function resolveEndpoint(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  return normalized.endsWith("/chat/completions") ? normalized : `${normalized}/chat/completions`;
}

function readCredential(config: ModelRequest["config"]): string {
  if (!config.apiKey?.trim()) throw new ModelClientError("credential-missing", config.credentialRef ? `未找到凭据引用 ${config.credentialRef} 对应的凭据。` : "尚未配置模型 API Key。");
  return config.apiKey;
}

async function httpError(response: Response): Promise<ModelClientError> {
  const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
  return new ModelClientError(`http-${response.status}`, `模型服务返回 HTTP ${response.status}。`, retryable, response.status);
}

function relayAbort(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => undefined;
  const listener = () => target.abort();
  source.addEventListener("abort", listener, { once: true });
  return () => source.removeEventListener("abort", listener);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined, controller: AbortController): Promise<T> {
  if (!timeoutMs) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => { const error = new ModelClientError("connect-timeout", "模型连接超过超时限制。", true); controller.abort(error); reject(error); }, timeoutMs); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
