import type { WorkspaceState } from "../../application/workspaceService";
import type { WorkerEvent } from "../../application/workerProtocol";
import type { ChatMessage, ModelConfig, ModelEvent } from "../../application/modelProtocol";
import type { CompressionOptions, CompressionResult } from "../../application/contextCompression";
import type { ToolManifest } from "../../application/toolProtocol";

export interface ModelEventEnvelope { requestId: string; event: ModelEvent; }

export interface TriMusicAgentApi {
  getInitializationState(): Promise<WorkspaceState>;
  chooseWorkspaceRoot(): Promise<WorkspaceState>;
  createSession(): Promise<WorkspaceState>;
  selectSession(sessionId: string): Promise<WorkspaceState>;
  compressSession(options: CompressionOptions): Promise<CompressionResult>;
  onInitializationState(listener: (state: WorkspaceState) => void): () => void;
  startWorker(operation: "ping" | "decrypt", payload: Record<string, unknown>): Promise<{ requestId: string; taskId: string }>;
  cancelWorker(taskId: string): Promise<boolean>;
  onWorkerEvent(listener: (event: WorkerEvent) => void): () => void;
  startModel(config: ModelConfig, messages: ChatMessage[], permissionMode: "restricted" | "standard" | "full"): Promise<{ requestId: string }>;
  cancelModel(requestId: string): Promise<boolean>;
  onModelEvent(listener: (envelope: ModelEventEnvelope) => void): () => void;
  listTools(): Promise<ToolManifest[]>;
  refreshTools(manifests: ToolManifest[]): Promise<ToolManifest[]>;
}

declare global {
  interface Window {
    triMusicAgent: TriMusicAgentApi;
  }
}

export {};
