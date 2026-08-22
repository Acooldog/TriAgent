import { contextBridge, ipcRenderer } from "electron";
import type { WorkspaceState } from "../application/workspaceService";
import type { WorkerEvent } from "../application/workerProtocol";
import type { ChatMessage, ModelConfig, ModelEvent } from "../application/modelProtocol";
import type { ToolManifest } from "../application/toolProtocol";

export interface ModelEventEnvelope {
  requestId: string;
  event: ModelEvent;
}

contextBridge.exposeInMainWorld("triMusicAgent", {
  getInitializationState: (): Promise<WorkspaceState> => ipcRenderer.invoke("app:get-initialization-state"),
  chooseWorkspaceRoot: (): Promise<WorkspaceState> => ipcRenderer.invoke("workspace:choose-root"),
  createSession: (): Promise<WorkspaceState> => ipcRenderer.invoke("session:create"),
  selectSession: (sessionId: string): Promise<WorkspaceState> => ipcRenderer.invoke("session:select", sessionId),
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
  onInitializationState: (listener: (state: WorkspaceState) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: WorkspaceState) => listener(state);
    ipcRenderer.on("app:initialization-state", handler);
    return () => ipcRenderer.removeListener("app:initialization-state", handler);
  },
});
