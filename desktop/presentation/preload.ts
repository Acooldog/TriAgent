import { contextBridge, ipcRenderer } from "electron";
import type { WorkspaceState } from "../application/workspaceService";
import type { WorkerEvent } from "../application/workerProtocol";

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
  onInitializationState: (listener: (state: WorkspaceState) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: WorkspaceState) => listener(state);
    ipcRenderer.on("app:initialization-state", handler);
    return () => ipcRenderer.removeListener("app:initialization-state", handler);
  },
});
