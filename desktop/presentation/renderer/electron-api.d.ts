import type { WorkspaceState } from "../../application/workspaceService";
import type { WorkerEvent } from "../../application/workerProtocol";

export interface TriMusicAgentApi {
  getInitializationState(): Promise<WorkspaceState>;
  chooseWorkspaceRoot(): Promise<WorkspaceState>;
  createSession(): Promise<WorkspaceState>;
  selectSession(sessionId: string): Promise<WorkspaceState>;
  onInitializationState(listener: (state: WorkspaceState) => void): () => void;
  startWorker(operation: "ping" | "decrypt", payload: Record<string, unknown>): Promise<{ requestId: string; taskId: string }>;
  cancelWorker(taskId: string): Promise<boolean>;
  onWorkerEvent(listener: (event: WorkerEvent) => void): () => void;
}

declare global {
  interface Window {
    triMusicAgent: TriMusicAgentApi;
  }
}

export {};
