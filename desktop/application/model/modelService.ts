import { parseStrictToolFallback, type ChatMessage, type ModelClient, type ModelConfig, type ModelEvent, type ModelResult } from "./modelProtocol";
import type { ExecutionBudget } from "../settings/executionBudget";
import { PermissionPolicyError, type PermissionPolicy } from "../settings/permissionPolicy";
import { ToolProtocolError, type PermissionMode, type ToolRegistry } from "../tools/toolProtocol";

export interface ModelServiceRequest {
  config: ModelConfig;
  messages: ChatMessage[];
  permissionMode: PermissionMode;
  allowJsonFallback?: boolean;
  signal?: AbortSignal;
  budget?: ExecutionBudget;
  networkEnabled?: boolean;
}

export class ModelService {
  public constructor(private readonly client: ModelClient, private readonly tools: ToolRegistry, private readonly permissions?: PermissionPolicy) {}

  public async stream(request: ModelServiceRequest, onEvent: (event: ModelEvent) => void): Promise<ModelResult> {
    request.budget?.recordModelTurn();
    const result = await this.client.stream({ config: request.config, messages: request.messages, tools: this.tools.openAiDefinitions(), signal: request.signal }, onEvent);
    const toolCalls = result.toolCalls.length > 0 ? result.toolCalls : request.allowJsonFallback ? fallbackToolCalls(result.text) : [];
    request.budget?.recordToolCalls(toolCalls.length);
    for (const toolCall of toolCalls) {
      try {
        const args = JSON.parse(toolCall.arguments) as unknown;
        this.tools.validate({ toolCallId: toolCall.id, toolId: toolCall.name, arguments: args, permissionMode: request.permissionMode });
        const manifest = this.tools.get(toolCall.name)!;
        await this.permissions?.authorize({ mode: request.permissionMode, operation: manifest.sensitive_operation ?? "built-in", networkEnabled: request.networkEnabled, title: "工具调用审批", detail: `是否允许调用工具 ${manifest.name}？` });
        onEvent({ type: "tool_call_accepted", toolCall });
      } catch (error) {
        if (error instanceof PermissionPolicyError) throw error;
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
