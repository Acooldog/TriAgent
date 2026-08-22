import { contextBridge, ipcRenderer } from "electron";
import type { WorkspaceState } from "../application/workspaceService";

contextBridge.exposeInMainWorld("triMusicAgent", {
  getInitializationState: (): Promise<WorkspaceState> => ipcRenderer.invoke("app:get-initialization-state"),
  chooseWorkspaceRoot: (): Promise<WorkspaceState> => ipcRenderer.invoke("workspace:choose-root"),
  createSession: (): Promise<WorkspaceState> => ipcRenderer.invoke("session:create"),
  selectSession: (sessionId: string): Promise<WorkspaceState> => ipcRenderer.invoke("session:select", sessionId),
  onInitializationState: (listener: (state: WorkspaceState) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: WorkspaceState) => listener(state);
    ipcRenderer.on("app:initialization-state", handler);
    return () => ipcRenderer.removeListener("app:initialization-state", handler);
  },
});
