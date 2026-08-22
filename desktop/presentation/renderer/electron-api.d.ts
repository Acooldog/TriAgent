import type { WorkspaceState } from "../../application/workspaceService";

export interface TriMusicAgentApi {
  getInitializationState(): Promise<WorkspaceState>;
  chooseWorkspaceRoot(): Promise<WorkspaceState>;
  createSession(): Promise<WorkspaceState>;
  selectSession(sessionId: string): Promise<WorkspaceState>;
  onInitializationState(listener: (state: WorkspaceState) => void): () => void;
}

declare global {
  interface Window {
    triMusicAgent: TriMusicAgentApi;
  }
}

export {};
