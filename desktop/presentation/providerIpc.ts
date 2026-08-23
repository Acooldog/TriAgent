import type { IpcMain } from "electron";
import { isRecord } from "../application/jsonSchema";
import { normalizeProviderError, sanitizeProviderData, type ProviderCall, type ProviderEvent } from "../application/providerProtocol";
import type { ProviderService, ProviderSessionContext } from "../application/providerService";
import type { ProviderRuntimeService } from "../application/providerRuntimeService";
import type { ProviderRuntimeStartRequest } from "../application/providerRuntimeProtocol";

export interface ProviderIpcDependencies {
  ipc: IpcMain;
  service: ProviderService;
  runtime?: ProviderRuntimeService;
  selectedContext: () => ProviderSessionContext | null;
  publishEvent: (event: ProviderEvent) => void;
}

export function registerProviderIpc(dependencies: ProviderIpcDependencies): void {
  const { ipc, service, runtime } = dependencies;
  ipc.handle("providers:list", () => service.list());
  ipc.handle("providers:refresh", () => service.refresh());
  ipc.handle("providers:health", (_event, providerId: unknown) => {
    if (typeof providerId !== "string" || !providerId.trim()) throw new Error("Provider ID 无效。");
    return service.checkHealth(providerId);
  });
  ipc.handle("providers:set-enabled", (_event, providerId: unknown, enabled: unknown) => {
    if (typeof providerId !== "string" || typeof enabled !== "boolean") throw new Error("Provider 启用设置无效。");
    return service.setEnabled(providerId, enabled);
  });
  ipc.handle("providers:invoke", (_event, value: unknown) => {
    const context = dependencies.selectedContext();
    if (!context) throw new Error("请先选择会话。");
    const call = parseProviderCall(value);
    const handle = service.start(call, context, dependencies.publishEvent);
    void handle.completion.then((result) => dependencies.publishEvent(terminalEvent(call, handle.requestId, handle.taskId, "completed", { output: sanitizeProviderData(result.output) }))).catch((error: unknown) => {
      const normalized = normalizeProviderError(error);
      dependencies.publishEvent(terminalEvent(call, handle.requestId, handle.taskId, normalized.code === "provider-cancelled" ? "cancelled" : "failed", {}, { code: normalized.code, message: normalized.message, retryable: normalized.retryable }));
    });
    return { requestId: handle.requestId, taskId: handle.taskId };
  });
  ipc.handle("providers:cancel", (_event, taskId: unknown) => {
    if (typeof taskId !== "string" || !taskId.trim()) return false;
    return service.cancel(taskId);
  });
  if (runtime) {
    ipc.handle("providers:runtime-list", () => runtime.list());
    ipc.handle("providers:runtime-discover", async () => runtime.discover(dependencies.selectedContext() ?? undefined));
    ipc.handle("providers:runtime-start", async (_event, value: unknown) => runtime.start(parseRuntimeStart(value), dependencies.selectedContext() ?? undefined));
    ipc.handle("providers:runtime-health", (_event, providerId: unknown) => {
      if (typeof providerId !== "string" || !providerId.trim()) throw new Error("Provider ID 无效。");
      return runtime.checkHealth(providerId, dependencies.selectedContext() ?? undefined);
    });
    ipc.handle("providers:runtime-stop", (_event, providerId: unknown) => {
      if (typeof providerId !== "string" || !providerId.trim()) throw new Error("Provider ID 无效。");
      return runtime.stop(providerId, dependencies.selectedContext() ?? undefined);
    });
    ipc.handle("providers:runtime-cancel", (_event, providerId: unknown) => typeof providerId === "string" && providerId.trim() ? runtime.cancel(providerId) : false);
  }
}

function terminalEvent(call: ProviderCall, requestId: string, taskId: string, status: "completed" | "failed" | "cancelled", payload: Record<string, unknown>, error?: ProviderEvent["error"]): ProviderEvent {
  return { protocol_version: "1", request_id: requestId, task_id: taskId, provider_id: call.providerId, capability_id: call.capabilityId, sequence: Number.MAX_SAFE_INTEGER, event_type: status === "completed" ? "provider_result" : status === "cancelled" ? "provider_cancelled" : "provider_failed", status, payload, ...(error ? { error } : {}), emitted_at: new Date().toISOString() };
}

function parseProviderCall(value: unknown): ProviderCall {
  if (!isRecord(value) || typeof value.providerId !== "string" || typeof value.capabilityId !== "string") throw new Error("Provider 调用请求无效。");
  if (value.permissionMode !== "restricted" && value.permissionMode !== "standard" && value.permissionMode !== "full") throw new Error("Provider 权限模式无效。");
  return { providerId: value.providerId, capabilityId: value.capabilityId, input: value.input, permissionMode: value.permissionMode };
}

function parseRuntimeStart(value: unknown): ProviderRuntimeStartRequest {
  if (!isRecord(value) || typeof value.providerId !== "string" || !value.providerId.trim()) throw new Error("Provider 启动请求无效。");
  if (value.permissionMode !== "restricted" && value.permissionMode !== "standard" && value.permissionMode !== "full") throw new Error("Provider 权限模式无效。");
  return { providerId: value.providerId, permissionMode: value.permissionMode };
}
