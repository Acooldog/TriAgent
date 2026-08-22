export const TOOL_PROTOCOL_VERSION = "1" as const;

export type PermissionMode = "restricted" | "standard" | "full";

export interface JsonSchema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: unknown[];
}

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
  if (!isRecord(manifest.input_schema)) throw new ToolProtocolError("schema", "工具输入 Schema 无效。");
  if (!Array.isArray(manifest.permissions) || manifest.permissions.length === 0) throw new ToolProtocolError("permission", "工具必须声明权限模式。");
  if (typeof manifest.timeout_ms !== "number" || !Number.isFinite(manifest.timeout_ms) || manifest.timeout_ms <= 0) throw new ToolProtocolError("timeout", "工具超时必须是正数。");
}

export function validateInvocation(manifest: ToolManifest, invocation: ToolInvocation): void {
  validateManifest(manifest);
  if (!manifest.permissions.includes(invocation.permissionMode)) throw new ToolProtocolError("permission-denied", `工具 ${manifest.tool_id} 不允许当前权限模式。`);
  const errors = validateJson(manifest.input_schema, invocation.arguments, "arguments");
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

function validateJson(schema: JsonSchema, value: unknown, path: string): string[] {
  const errors: string[] = [];
  if (schema.enum && !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) errors.push(`${path} 不在允许值范围内`);
  if (schema.type && !matchesType(schema.type, value)) errors.push(`${path} 类型应为 ${schema.type}`);
  if (schema.type === "object" && isRecord(value)) {
    for (const required of schema.required ?? []) if (!(required in value)) errors.push(`${path}.${required} 必填`);
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) if (!schema.properties?.[key]) errors.push(`${path}.${key} 不允许`);
    for (const [key, child] of Object.entries(schema.properties ?? {})) if (key in value) errors.push(...validateJson(child, value[key], `${path}.${key}`));
  }
  if (schema.type === "array" && Array.isArray(value) && schema.items) value.forEach((item, index) => errors.push(...validateJson(schema.items!, item, `${path}[${index}]`)));
  return errors;
}

function matchesType(type: NonNullable<JsonSchema["type"]>, value: unknown): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isRecord(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  return typeof value === type;
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isNonEmptyString(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
