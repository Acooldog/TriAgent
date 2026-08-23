import type { WorkspaceState } from "../../application/workspaceService";
import type { WorkerEvent } from "../../application/workerProtocol";
import type { ChatMessage, ModelConfig, ModelEvent } from "../../application/modelProtocol";
import type { CompressionOptions, CompressionResult } from "../../application/contextCompression";
import type { ToolManifest } from "../../application/toolProtocol";
import type { ProviderCall, ProviderEvent, ProviderRegistration } from "../../application/providerProtocol";

export interface ModelEventEnvelope { requestId: string; event: ModelEvent; }

export interface TriMusicAgentApi {
  getInitializationState(): Promise<WorkspaceState>;
  chooseWorkspaceRoot(): Promise<WorkspaceState>;
  createSession(): Promise<WorkspaceState>;
  selectSession(sessionId: string): Promise<WorkspaceState>;
  compressSession(options: CompressionOptions): Promise<CompressionResult>;
  restoreOriginalContext(): Promise<WorkspaceState>;
  onInitializationState(listener: (state: WorkspaceState) => void): () => void;
  onPersistenceError(listener: (error: { label: string; message: string }) => void): () => void;
  startWorker(operation: "ping" | "decrypt", payload: Record<string, unknown>): Promise<{ requestId: string; taskId: string }>;
  cancelWorker(taskId: string): Promise<boolean>;
  onWorkerEvent(listener: (event: WorkerEvent) => void): () => void;
  startModel(config: ModelConfig, messages: ChatMessage[], permissionMode: "restricted" | "standard" | "full"): Promise<{ requestId: string }>;
  cancelModel(requestId: string): Promise<boolean>;
  onModelEvent(listener: (envelope: ModelEventEnvelope) => void): () => void;
  listTools(): Promise<ToolManifest[]>;
  refreshTools(manifests: ToolManifest[]): Promise<ToolManifest[]>;
  listProviders(): Promise<ProviderRegistration[]>;
  refreshProviders(): Promise<ProviderRegistration[]>;
  checkProviderHealth(providerId: string): Promise<ProviderRegistration>;
  setProviderEnabled(providerId: string, enabled: boolean): Promise<ProviderRegistration>;
  invokeProvider(call: ProviderCall): Promise<{ requestId: string; taskId: string }>;
  cancelProvider(taskId: string): Promise<boolean>;
  onProviderEvent(listener: (event: ProviderEvent) => void): () => void;
}

declare global {
  interface Window {
    triMusicAgent: TriMusicAgentApi;
  }
}

export {};
