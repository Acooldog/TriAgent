import { parseStrictToolFallback, type ChatMessage, type ModelClient, type ModelConfig, type ModelEvent, type ModelResult } from "./modelProtocol";
import { ToolProtocolError, type PermissionMode, type ToolRegistry } from "./toolProtocol";

export interface ModelServiceRequest {
  config: ModelConfig;
  messages: ChatMessage[];
  permissionMode: PermissionMode;
  allowJsonFallback?: boolean;
  signal?: AbortSignal;
}

export class ModelService {
  public constructor(private readonly client: ModelClient, private readonly tools: ToolRegistry) {}

  public async stream(request: ModelServiceRequest, onEvent: (event: ModelEvent) => void): Promise<ModelResult> {
    const result = await this.client.stream({ config: request.config, messages: request.messages, tools: this.tools.openAiDefinitions(), signal: request.signal }, onEvent);
    const toolCalls = result.toolCalls.length > 0 ? result.toolCalls : request.allowJsonFallback ? fallbackToolCalls(result.text) : [];
    for (const toolCall of toolCalls) {
      try {
        const args = JSON.parse(toolCall.arguments) as unknown;
        this.tools.validate({ toolCallId: toolCall.id, toolId: toolCall.name, arguments: args, permissionMode: request.permissionMode });
        onEvent({ type: "tool_call_accepted", toolCall });
      } catch (error) {
        const normalized = error instanceof ToolProtocolError ? error : new ToolProtocolError("invalid-arguments", "工具参数不是有效 JSON。");
        onEvent({ type: "tool_call_rejected", toolCall, code: normalized.code, message: normalized.message });
        throw normalized;
      }
    }
    return { ...result, toolCalls };
  }
}

function fallbackToolCalls(text: string): NonNullable<ReturnType<typeof parseStrictToolFallback>>[] {
  const call = parseStrictToolFallback(text);
  return call ? [call] : [];
}
