import { isNonEmptyString, isRecord, validateJsonSchema, validateJsonValue, type JsonSchema } from "./jsonSchema";

export type { JsonSchema } from "./jsonSchema";

export const TOOL_PROTOCOL_VERSION = "1" as const;

export type PermissionMode = "restricted" | "standard" | "full";

export interface ToolManifest {
  protocol_version: typeof TOOL_PROTOCOL_VERSION;
  tool_id: string;
  version: string;
  name: string;
  description: string;
  input_schema: JsonSchema;
  output_schema?: JsonSchema;
  capabilities: string[];
  permissions: PermissionMode[];
  events: string[];
  cancellation: boolean;
  timeout_ms: number;
}

export interface ToolInvocation {
  toolCallId: string;
  toolId: string;
  arguments: unknown;
  permissionMode: PermissionMode;
}

export class ToolProtocolError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ToolProtocolError";
  }
}

export function validateManifest(manifest: unknown): asserts manifest is ToolManifest {
  if (!isRecord(manifest)) throw new ToolProtocolError("manifest-fields", "工具 manifest 必须是对象。");
  if (!Array.isArray(manifest.capabilities) || !Array.isArray(manifest.events) || typeof manifest.cancellation !== "boolean") throw new ToolProtocolError("manifest-fields", "工具 manifest 的能力、事件或取消声明无效。");
  if (manifest.protocol_version !== TOOL_PROTOCOL_VERSION) throw new ToolProtocolError("protocol-version", "工具协议版本不兼容。");
  for (const field of ["tool_id", "version", "name", "description"] as const) {
    if (!isNonEmptyString(manifest[field])) throw new ToolProtocolError("manifest-field", `工具 manifest 缺少 ${field}。`);
  }
  try {
    validateJsonSchema(manifest.input_schema, "工具输入 Schema");
    if (manifest.output_schema !== undefined) validateJsonSchema(manifest.output_schema, "工具输出 Schema");
  } catch (error) {
    throw new ToolProtocolError("schema", error instanceof Error ? error.message : "工具 Schema 无效。");
  }
  if (!Array.isArray(manifest.permissions) || manifest.permissions.length === 0) throw new ToolProtocolError("permission", "工具必须声明权限模式。");
  if (typeof manifest.timeout_ms !== "number" || !Number.isFinite(manifest.timeout_ms) || manifest.timeout_ms <= 0) throw new ToolProtocolError("timeout", "工具超时必须是正数。");
}

export function validateInvocation(manifest: ToolManifest, invocation: ToolInvocation): void {
  validateManifest(manifest);
  if (!manifest.permissions.includes(invocation.permissionMode)) throw new ToolProtocolError("permission-denied", `工具 ${manifest.tool_id} 不允许当前权限模式。`);
  const errors = validateJsonValue(manifest.input_schema, invocation.arguments, "arguments");
  if (errors.length > 0) throw new ToolProtocolError("invalid-arguments", errors.join("；"));
}

export class ToolRegistry {
  private readonly manifests = new Map<string, ToolManifest>();

  public register(manifest: ToolManifest): void {
    validateManifest(manifest);
    this.manifests.set(manifest.tool_id, structuredClone(manifest));
  }

  public refresh(manifests: ToolManifest[]): void {
    const next = new Map<string, ToolManifest>();
    for (const manifest of manifests) {
      validateManifest(manifest);
      if (next.has(manifest.tool_id)) throw new ToolProtocolError("duplicate-tool", `工具 ${manifest.tool_id} 重复注册。`);
      next.set(manifest.tool_id, structuredClone(manifest));
    }
    this.manifests.clear();
    for (const [toolId, manifest] of next) this.manifests.set(toolId, manifest);
  }

  public list(): ToolManifest[] { return [...this.manifests.values()].map((manifest) => structuredClone(manifest)); }

  public openAiDefinitions(): Array<Record<string, unknown>> {
    return this.list().map((manifest) => ({ type: "function", function: { name: manifest.tool_id, description: manifest.description, parameters: manifest.input_schema } }));
  }

  public get(toolId: string): ToolManifest | undefined { const manifest = this.manifests.get(toolId); return manifest ? structuredClone(manifest) : undefined; }

  public validate(invocation: ToolInvocation): void {
    const manifest = this.manifests.get(invocation.toolId);
    if (!manifest) throw new ToolProtocolError("unknown-tool", `工具 ${invocation.toolId} 未注册。`);
    validateInvocation(manifest, invocation);
  }
}
