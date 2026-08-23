import { contextBridge, ipcRenderer } from "electron";
import type { WorkspaceState } from "../application/workspaceService";
import type { WorkerEvent } from "../application/workerProtocol";
import type { ChatMessage, ModelConfig, ModelEvent } from "../application/modelProtocol";
import type { CompressionOptions, CompressionResult } from "../application/contextCompression";
import type { ToolManifest } from "../application/toolProtocol";
import type { ProviderCall, ProviderEvent, ProviderRegistration } from "../application/providerProtocol";

export interface ModelEventEnvelope {
  requestId: string;
  event: ModelEvent;
}

contextBridge.exposeInMainWorld("triMusicAgent", {
  getInitializationState: (): Promise<WorkspaceState> => ipcRenderer.invoke("app:get-initialization-state"),
  chooseWorkspaceRoot: (): Promise<WorkspaceState> => ipcRenderer.invoke("workspace:choose-root"),
  createSession: (): Promise<WorkspaceState> => ipcRenderer.invoke("session:create"),
  selectSession: (sessionId: string): Promise<WorkspaceState> => ipcRenderer.invoke("session:select", sessionId),
  compressSession: (options: CompressionOptions): Promise<CompressionResult> => ipcRenderer.invoke("session:compress", options),
  restoreOriginalContext: (): Promise<WorkspaceState> => ipcRenderer.invoke("session:restore-original"),
  startWorker: (operation: "ping" | "decrypt", payload: Record<string, unknown>): Promise<{ requestId: string; taskId: string }> => ipcRenderer.invoke("worker:start", operation, payload),
  cancelWorker: (taskId: string): Promise<boolean> => ipcRenderer.invoke("worker:cancel", taskId),
  onWorkerEvent: (listener: (event: WorkerEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, workerEvent: WorkerEvent) => listener(workerEvent);
    ipcRenderer.on("worker:event", handler);
    return () => ipcRenderer.removeListener("worker:event", handler);
  },
  startModel: (config: ModelConfig, messages: ChatMessage[], permissionMode: "restricted" | "standard" | "full"): Promise<{ requestId: string }> => ipcRenderer.invoke("model:stream", config, messages, permissionMode),
  cancelModel: (requestId: string): Promise<boolean> => ipcRenderer.invoke("model:cancel", requestId),
  onModelEvent: (listener: (envelope: ModelEventEnvelope) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, envelope: ModelEventEnvelope) => listener(envelope);
    ipcRenderer.on("model:event", handler);
    return () => ipcRenderer.removeListener("model:event", handler);
  },
  listTools: (): Promise<ToolManifest[]> => ipcRenderer.invoke("tools:list"),
  refreshTools: (manifests: ToolManifest[]): Promise<ToolManifest[]> => ipcRenderer.invoke("tools:refresh", manifests),
  listProviders: (): Promise<ProviderRegistration[]> => ipcRenderer.invoke("providers:list"),
  refreshProviders: (): Promise<ProviderRegistration[]> => ipcRenderer.invoke("providers:refresh"),
  checkProviderHealth: (providerId: string): Promise<ProviderRegistration> => ipcRenderer.invoke("providers:health", providerId),
  setProviderEnabled: (providerId: string, enabled: boolean): Promise<ProviderRegistration> => ipcRenderer.invoke("providers:set-enabled", providerId, enabled),
  invokeProvider: (call: ProviderCall): Promise<{ requestId: string; taskId: string }> => ipcRenderer.invoke("providers:invoke", call),
  cancelProvider: (taskId: string): Promise<boolean> => ipcRenderer.invoke("providers:cancel", taskId),
  onProviderEvent: (listener: (event: ProviderEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, providerEvent: ProviderEvent) => listener(providerEvent);
    ipcRenderer.on("provider:event", handler);
    return () => ipcRenderer.removeListener("provider:event", handler);
  },
  onInitializationState: (listener: (state: WorkspaceState) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: WorkspaceState) => listener(state);
    ipcRenderer.on("app:initialization-state", handler);
    return () => ipcRenderer.removeListener("app:initialization-state", handler);
  },
  onPersistenceError: (listener: (error: { label: string; message: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, error: { label: string; message: string }) => listener(error);
    ipcRenderer.on("session:persistence-error", handler);
    return () => ipcRenderer.removeListener("session:persistence-error", handler);
  },
});
