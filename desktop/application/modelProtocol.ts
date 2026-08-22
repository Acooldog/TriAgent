export type ThinkingMode = "enabled" | "disabled";

export interface ModelConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  credentialRef?: string;
  headers?: Record<string, string>;
  stream?: boolean;
  thinking?: ThinkingMode;
  maxTokens?: number;
  temperature?: number;
  connectTimeoutMs?: number;
  firstByteTimeoutMs?: number;
  readTimeoutMs?: number;
  totalTimeoutMs?: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type ModelEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call_delta"; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: "tool_call_accepted"; toolCall: ToolCall }
  | { type: "tool_call_rejected"; toolCall: ToolCall; code: string; message: string }
  | { type: "response_completed"; finishReason: string | null }
  | { type: "error"; code: string; message: string; retryable: boolean; status?: number };

export interface ModelRequest {
  config: ModelConfig;
  messages: ChatMessage[];
  tools?: Array<Record<string, unknown>>;
  signal?: AbortSignal;
}

export interface ModelResult {
  text: string;
  reasoning: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
}

export interface ModelClient {
  stream(request: ModelRequest, onEvent: (event: ModelEvent) => void): Promise<ModelResult>;
}

export class ModelClientError extends Error {
  public constructor(public readonly code: string, message: string, public readonly retryable = false, public readonly status?: number) {
    super(message);
    this.name = "ModelClientError";
  }
}

export function parseStrictToolFallback(text: string): ToolCall | null {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.arguments !== "object" || value.arguments === null) return null;
  return { id: typeof value.id === "string" ? value.id : "fallback-tool-call", name: value.name, arguments: JSON.stringify(value.arguments) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
