import type { IpcMain } from "electron";
import { isRecord } from "../application/jsonSchema";
import type { ProviderCall, ProviderEvent } from "../application/providerProtocol";
import type { ProviderService, ProviderSessionContext } from "../application/providerService";

export interface ProviderIpcDependencies {
  ipc: IpcMain;
  service: ProviderService;
  selectedContext: () => ProviderSessionContext | null;
  publishEvent: (event: ProviderEvent) => void;
}

export function registerProviderIpc(dependencies: ProviderIpcDependencies): void {
  const { ipc, service } = dependencies;
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
    const handle = service.start(parseProviderCall(value), context, dependencies.publishEvent);
    void handle.completion.catch(() => undefined);
    return { requestId: handle.requestId, taskId: handle.taskId };
  });
  ipc.handle("providers:cancel", (_event, taskId: unknown) => {
    if (typeof taskId !== "string" || !taskId.trim()) return false;
    return service.cancel(taskId);
  });
}

function parseProviderCall(value: unknown): ProviderCall {
  if (!isRecord(value) || typeof value.providerId !== "string" || typeof value.capabilityId !== "string") throw new Error("Provider 调用请求无效。");
  if (value.permissionMode !== "restricted" && value.permissionMode !== "standard" && value.permissionMode !== "full") throw new Error("Provider 权限模式无效。");
  return { providerId: value.providerId, capabilityId: value.capabilityId, input: value.input, permissionMode: value.permissionMode };
}
