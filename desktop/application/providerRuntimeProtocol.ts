import type { ProviderHealth, ProviderManifest } from "./providerProtocol";
import { sanitizeProviderData } from "./providerProtocol";
import type { PermissionMode } from "./toolProtocol";

export type ProviderRuntimeStatus = "unconfigured" | "stopped" | "starting" | "healthy" | "unhealthy" | "stopping";
export type ProviderRuntimePhase = "discover" | "start" | "handshake" | "health" | "stop" | "recover" | "run" | "crash";

export interface ProviderRuntimeDescriptor {
  providerId: string;
  displayName: string;
  cancellation: boolean;
}

export interface ProviderRuntimeInstance {
  providerId: string;
  instanceId: string;
}

export interface ProviderRuntimeExit extends ProviderRuntimeInstance {
  emittedAt?: string;
  exitCode?: number | null;
  error?: unknown;
}

export interface ProviderRuntimeState {
  providerId: string | null;
  displayName: string;
  status: ProviderRuntimeStatus;
  instanceId?: string;
  checkedAt?: string;
  message?: string;
  recoverySuggestion?: string;
  updatedAt: string;
}

export interface ProviderRuntimeEvent {
  providerId: string | null;
  operationId: string;
  sequence: number;
  eventType: string;
  status: ProviderRuntimeStatus;
  payload: Record<string, unknown>;
  error?: { code: string; message: string };
  emittedAt: string;
}

export interface ProviderRuntimeStartRequest {
  providerId: string;
  permissionMode: PermissionMode;
}

export interface ProviderRuntimeApprovalRequest extends ProviderRuntimeStartRequest {
  displayName: string;
  reason: string;
}

export interface ProviderRuntimeApproval {
  requestStartApproval(request: ProviderRuntimeApprovalRequest): Promise<boolean>;
}

export interface ProviderRuntimeTimeouts {
  discoveryMs: number;
  startMs: number;
  handshakeMs: number;
  operationMs: number;
  runMs: number;
}

export interface ProviderRuntimeGateway {
  discover(signal: AbortSignal): Promise<ProviderRuntimeDescriptor[]>;
  start(providerId: string, signal: AbortSignal): Promise<ProviderRuntimeInstance>;
  handshake(providerId: string, instanceId: string, signal: AbortSignal): Promise<ProviderManifest>;
  checkHealth(providerId: string, instanceId: string, signal: AbortSignal): Promise<ProviderHealth>;
  stop(providerId: string, instanceId: string, signal: AbortSignal): Promise<void>;
  cancel(providerId: string, instanceId: string): Promise<boolean>;
  recover(signal: AbortSignal): Promise<ProviderRuntimeInstance[]>;
  onExit(listener: (event: ProviderRuntimeExit) => void): () => void;
}

export class ProviderRuntimeError extends Error {
  public constructor(public readonly code: string, message: string, public readonly phase: ProviderRuntimePhase, public readonly retryable = false) {
    super(message);
    this.name = "ProviderRuntimeError";
  }
}

export const DEFAULT_PROVIDER_RUNTIME_TIMEOUTS: ProviderRuntimeTimeouts = {
  discoveryMs: 5_000,
  startMs: 15_000,
  handshakeMs: 8_000,
  operationMs: 5_000,
  runMs: 15 * 60 * 1_000,
};

export function validateRuntimeDescriptor(value: ProviderRuntimeDescriptor): void {
  if (!value || typeof value.providerId !== "string" || !value.providerId.trim() || typeof value.displayName !== "string" || !value.displayName.trim() || typeof value.cancellation !== "boolean") {
    throw new ProviderRuntimeError("provider-runtime-discovery-invalid", "Provider 运行时发现结果无效。", "discover");
  }
}

export function normalizeProviderRuntimeError(error: unknown, phase: ProviderRuntimePhase): ProviderRuntimeError {
  if (error instanceof ProviderRuntimeError) return new ProviderRuntimeError(error.code, sanitizeText(error.message), error.phase, error.retryable);
  if (error instanceof Error && error.name === "AbortError") return new ProviderRuntimeError("provider-runtime-cancelled", "Provider 运行时操作已取消。", phase);
  const timeoutCode = phase === "start" ? "provider-runtime-start-timeout" : phase === "handshake" ? "provider-runtime-handshake-timeout" : phase === "run" ? "provider-runtime-run-timeout" : "provider-runtime-operation-timeout";
  if (error instanceof Error && error.name === "TimeoutError") return new ProviderRuntimeError(timeoutCode, timeoutMessage(phase), phase);
  if (phase === "crash") return new ProviderRuntimeError("provider-runtime-crashed", "Provider 运行时异常退出。", phase, true);
  return new ProviderRuntimeError(`provider-runtime-${phase}-failed`, failureMessage(phase), phase, phase === "health");
}

export function sanitizeRuntimePayload(value: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizeProviderData(value);
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized) ? sanitized as Record<string, unknown> : {};
}

function sanitizeText(value: string): string { return String(sanitizeProviderData(value)); }
function timeoutMessage(phase: ProviderRuntimePhase): string {
  if (phase === "start") return "Provider 启动超时。";
  if (phase === "handshake") return "Provider 握手超时。";
  if (phase === "run") return "Provider 运行超时，任务已停止。";
  return "Provider 运行时操作超时。";
}
function failureMessage(phase: ProviderRuntimePhase): string {
  if (phase === "discover") return "Provider 运行时发现失败。";
  if (phase === "start") return "Provider 启动失败。";
  if (phase === "handshake") return "Provider 握手失败。";
  if (phase === "health") return "Provider 健康检查失败。";
  if (phase === "stop") return "Provider 停止失败。";
  if (phase === "recover") return "Provider 状态恢复失败。";
  return "Provider 运行时操作失败。";
}
