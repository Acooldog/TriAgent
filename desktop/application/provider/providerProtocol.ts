import { isNonEmptyString, isRecord, validateJsonSchema, validateJsonValue, type JsonSchema } from "../tools/jsonSchema";
import type { PermissionMode } from "../tools/toolProtocol";

export const PROVIDER_PROTOCOL_VERSION = "1" as const;

export type ProviderEventStatus = "running" | "completed" | "failed" | "cancelled";
export type ProviderHealthStatus = "unknown" | "healthy" | "unhealthy";

export interface ProviderCapabilityManifest {
  capability_id: string;
  name: string;
  description: string;
  input_schema: JsonSchema;
  output_schema: JsonSchema;
  permissions: PermissionMode[];
  events: string[];
  cancellation: boolean;
  timeout_ms: number;
}

export interface ProviderManifest {
  protocol_version: typeof PROVIDER_PROTOCOL_VERSION;
  provider_id: string;
  version: string;
  name: string;
  description: string;
  capabilities: ProviderCapabilityManifest[];
}

export interface ProviderHealth {
  status: ProviderHealthStatus;
  checkedAt?: string;
  message?: string;
}

export interface ProviderRegistration {
  manifest: ProviderManifest;
  enabled: boolean;
  health: ProviderHealth;
}

export interface ProviderCall {
  providerId: string;
  capabilityId: string;
  input: unknown;
  permissionMode: PermissionMode;
}

export interface ProviderInvocationRequest extends ProviderCall {
  requestId: string;
  taskId: string;
  timeoutMs: number;
}

export interface ProviderArtifact {
  artifact_id: string;
  relative_path: string;
  kind: string;
  metadata?: Record<string, unknown>;
}

export interface ProviderEvent {
  protocol_version: typeof PROVIDER_PROTOCOL_VERSION;
  request_id: string;
  task_id: string;
  provider_id: string;
  capability_id: string;
  sequence: number;
  event_type: string;
  status: ProviderEventStatus;
  payload: Record<string, unknown>;
  error?: { code: string; message: string; retryable?: boolean } | null;
  artifacts?: ProviderArtifact[];
  emitted_at: string;
}

export interface ProviderGatewayResult {
  output: unknown;
  artifacts?: ProviderArtifact[];
}

export interface ProviderGateway {
  discover(): Promise<ProviderManifest[]>;
  checkHealth(providerId: string): Promise<ProviderHealth>;
  invoke(request: ProviderInvocationRequest, onEvent: (event: ProviderEvent) => void, signal: AbortSignal): Promise<ProviderGatewayResult>;
  cancel(providerId: string, taskId: string): Promise<boolean>;
}

export class ProviderContractError extends Error {
  public constructor(public readonly code: string, message: string, public readonly retryable = false) {
    super(message);
    this.name = "ProviderContractError";
  }
}

export function validateProviderManifest(value: unknown): asserts value is ProviderManifest {
  if (!isRecord(value)) throw new ProviderContractError("provider-manifest-invalid", "Provider manifest 必须是对象。");
  if (value.protocol_version !== PROVIDER_PROTOCOL_VERSION) throw new ProviderContractError("provider-incompatible", "Provider 协议版本不兼容。");
  for (const field of ["provider_id", "version", "name", "description"] as const) {
    if (!isNonEmptyString(value[field])) throw new ProviderContractError("provider-manifest-invalid", `Provider manifest 缺少 ${field}。`);
  }
  if (!Array.isArray(value.capabilities) || value.capabilities.length === 0) throw new ProviderContractError("provider-manifest-invalid", "Provider 必须声明至少一项能力。");
  const ids = new Set<string>();
  for (const capability of value.capabilities) {
    validateCapability(capability);
    if (ids.has(capability.capability_id)) throw new ProviderContractError("provider-capability-duplicate", `Provider 能力 ${capability.capability_id} 重复。`);
    ids.add(capability.capability_id);
  }
}

export function validateProviderInput(capability: ProviderCapabilityManifest, input: unknown): void {
  const errors = validateJsonValue(capability.input_schema, input, "input");
  if (errors.length) throw new ProviderContractError("provider-input-schema", errors.join("；"));
}

export function validateProviderOutput(capability: ProviderCapabilityManifest, output: unknown): void {
  const errors = validateJsonValue(capability.output_schema, output, "output");
  if (errors.length) throw new ProviderContractError("provider-output-schema", errors.join("；"));
}

export function validateProviderEvent(event: unknown, request: ProviderInvocationRequest, capability: ProviderCapabilityManifest): asserts event is ProviderEvent {
  if (!isRecord(event) || event.protocol_version !== PROVIDER_PROTOCOL_VERSION) throw new ProviderContractError("provider-event-invalid", "Provider 事件协议无效。");
  if (event.request_id !== request.requestId || event.task_id !== request.taskId || event.provider_id !== request.providerId || event.capability_id !== request.capabilityId) throw new ProviderContractError("provider-event-mismatch", "Provider 事件与当前调用不匹配。");
  if (!Number.isInteger(event.sequence) || Number(event.sequence) < 0 || !isNonEmptyString(event.event_type) || !capability.events.includes(event.event_type)) throw new ProviderContractError("provider-event-invalid", "Provider 事件类型或顺序无效。");
  if (!isEventStatus(event.status) || !isRecord(event.payload) || !isNonEmptyString(event.emitted_at)) throw new ProviderContractError("provider-event-invalid", "Provider 事件字段无效。");
  if (event.error !== undefined && event.error !== null) {
    if (!isRecord(event.error) || !isNonEmptyString(event.error.code) || !isNonEmptyString(event.error.message) || (event.error.retryable !== undefined && typeof event.error.retryable !== "boolean")) throw new ProviderContractError("provider-event-invalid", "Provider 事件错误字段无效。");
  }
  if (event.artifacts !== undefined) validateArtifacts(event.artifacts);
}

export function validateArtifacts(value: unknown): asserts value is ProviderArtifact[] {
  if (!Array.isArray(value)) throw new ProviderContractError("provider-artifact-invalid", "Provider 产物列表无效。");
  for (const artifact of value) {
    if (!isRecord(artifact) || !isNonEmptyString(artifact.artifact_id) || !isSafeRelativePath(artifact.relative_path) || !isNonEmptyString(artifact.kind)) throw new ProviderContractError("provider-artifact-invalid", "Provider 产物引用无效。");
    if (artifact.metadata !== undefined && !isRecord(artifact.metadata)) throw new ProviderContractError("provider-artifact-invalid", "Provider 产物元数据无效。");
  }
}

export function normalizeProviderError(error: unknown): ProviderContractError {
  if (error instanceof ProviderContractError) return new ProviderContractError(error.code, redactText(error.message), error.retryable);
  if (error instanceof Error && error.name === "AbortError") return new ProviderContractError("provider-cancelled", "Provider 调用已取消。");
  return new ProviderContractError("provider-execution-failed", "Provider 执行失败。");
}

export function sanitizeProviderData(value: unknown): unknown {
  return sanitizeValue(value, new WeakSet<object>());
}

function validateCapability(value: unknown): asserts value is ProviderCapabilityManifest {
  if (!isRecord(value)) throw new ProviderContractError("provider-manifest-invalid", "Provider 能力声明必须是对象。");
  for (const field of ["capability_id", "name", "description"] as const) if (!isNonEmptyString(value[field])) throw new ProviderContractError("provider-manifest-invalid", `Provider 能力缺少 ${field}。`);
  try { validateJsonSchema(value.input_schema, "Provider 输入 Schema"); validateJsonSchema(value.output_schema, "Provider 输出 Schema"); } catch (error) { throw new ProviderContractError("provider-schema-invalid", error instanceof Error ? error.message : "Provider Schema 无效。"); }
  if (!Array.isArray(value.permissions) || value.permissions.length === 0 || !value.permissions.every(isPermissionMode)) throw new ProviderContractError("provider-permission-invalid", "Provider 权限声明无效。");
  if (!Array.isArray(value.events) || value.events.length === 0 || !value.events.every(isNonEmptyString)) throw new ProviderContractError("provider-event-invalid", "Provider 事件声明无效。");
  if (typeof value.cancellation !== "boolean") throw new ProviderContractError("provider-cancellation-invalid", "Provider 取消声明无效。");
  if (typeof value.timeout_ms !== "number" || !Number.isFinite(value.timeout_ms) || value.timeout_ms <= 0) throw new ProviderContractError("provider-timeout-invalid", "Provider 超时声明无效。");
}

function isPermissionMode(value: unknown): value is PermissionMode { return value === "restricted" || value === "standard" || value === "full"; }
function isEventStatus(value: unknown): value is ProviderEventStatus { return value === "running" || value === "completed" || value === "failed" || value === "cancelled"; }
function isSensitiveKey(key: string): boolean { return /authorization|api[-_]?key|token|secret|cookie|credential|session/i.test(key); }
function sanitizeValue(value: unknown, ancestors: WeakSet<object>): unknown {
  if (!Array.isArray(value) && !isRecord(value)) return typeof value === "string" ? redactText(value) : value;
  if (ancestors.has(value)) return "[循环引用已脱敏]";
  ancestors.add(value);
  const sanitized = Array.isArray(value)
    ? value.map((item) => sanitizeValue(item, ancestors))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, isSensitiveKey(key) ? "[已脱敏]" : sanitizeValue(item, ancestors)]));
  ancestors.delete(value);
  return sanitized;
}
function redactText(value: string): string {
  return value
    .replace(/(authorization|api[-_]?key|token|secret|cookie|credential|session)\s*[:=]\s*[^\s,;]+/gi, "$1=[已脱敏]")
    .replace(/[a-z]:\\[^,;\r\n]*/gi, "[本地路径已脱敏]")
    .replace(/\\\\[^,;\r\n]+/g, "[网络路径已脱敏]");
}
function isSafeRelativePath(value: unknown): value is string { return isNonEmptyString(value) && !/^(?:[a-z]:|[\\/])/i.test(value) && !value.split(/[\\/]+/).includes(".."); }
