import type { WorkspaceState } from "../../application/workspaceService";
import type { AgentEvent, AgentPlan } from "../../application/agentTaskService";
import type { WorkerEvent } from "../../application/workerProtocol";
import type { ChatMessage, ModelConfig, ModelEvent } from "../../application/modelProtocol";
import type { CompressionOptions, CompressionResult } from "../../application/contextCompression";
import type { ToolManifest } from "../../application/toolProtocol";
import type { ProviderCall, ProviderEvent, ProviderRegistration } from "../../application/providerProtocol";
import type { ProviderRuntimeEvent, ProviderRuntimeStartRequest, ProviderRuntimeState } from "../../application/providerRuntimeProtocol";
import type { DiagnosticReport, DiagnosticsRequest, ErrorSearchIssue, ErrorSearchResult } from "../../application/diagnostics";
import type { AppSettings } from "../../application/appSettings";

export interface ModelEventEnvelope { requestId: string; event: ModelEvent; }

export interface TriMusicAgentApi {
  getInitializationState(): Promise<WorkspaceState>;
  chooseWorkspaceRoot(): Promise<WorkspaceState>;
  createSession(): Promise<WorkspaceState>;
  selectSession(sessionId: string): Promise<WorkspaceState>;
  compressSession(options: CompressionOptions): Promise<CompressionResult>;
  restoreOriginalContext(): Promise<WorkspaceState>;
  planAgentTask(prompt: string): Promise<AgentPlan>;
  startAgentTask(prompt: string, permissionMode: "restricted" | "standard" | "full"): Promise<{ taskId: string; plan: AgentPlan }>;
  cancelAgentTask(taskId: string): Promise<boolean>;
  onAgentEvent(listener: (event: AgentEvent) => void): () => void;
  onInitializationState(listener: (state: WorkspaceState) => void): () => void;
  onPersistenceError(listener: (error: { label: string; message: string }) => void): () => void;
  onSessionPersistenceWarning(listener: (warning: { requestId: string; message: string }) => void): () => void;
  startWorker(operation: "ping" | "capability", payload: Record<string, unknown>, permissionMode: "restricted" | "standard" | "full"): Promise<{ requestId: string; taskId: string }>;
  cancelWorker(taskId: string): Promise<boolean>;
  onWorkerEvent(listener: (event: WorkerEvent) => void): () => void;
  startModel(config: ModelConfig, messages: ChatMessage[], permissionMode: "restricted" | "standard" | "full", networkEnabled: boolean): Promise<{ requestId: string }>;
  saveModelConfig(config: ModelConfig): Promise<boolean>;
  cancelModel(requestId: string): Promise<boolean>;
  onModelEvent(listener: (envelope: ModelEventEnvelope) => void): () => void;
  listTools(): Promise<ToolManifest[]>;
  refreshTools(manifests: ToolManifest[]): Promise<ToolManifest[]>;
  runDiagnostics(request: DiagnosticsRequest): Promise<DiagnosticReport>;
  searchDiagnosticError(issue: ErrorSearchIssue, permissionMode: "restricted" | "standard" | "full", networkEnabled: boolean): Promise<ErrorSearchResult>;
  listProviders(): Promise<ProviderRegistration[]>;
  refreshProviders(): Promise<ProviderRegistration[]>;
  checkProviderHealth(providerId: string): Promise<ProviderRegistration>;
  setProviderEnabled(providerId: string, enabled: boolean): Promise<ProviderRegistration>;
  invokeProvider(call: ProviderCall): Promise<{ requestId: string; taskId: string }>;
  cancelProvider(taskId: string): Promise<boolean>;
  listProviderRuntimes(): Promise<ProviderRuntimeState[]>;
  discoverProviderRuntimes(): Promise<ProviderRuntimeState[]>;
  startProviderRuntime(request: ProviderRuntimeStartRequest): Promise<ProviderRuntimeState>;
  checkProviderRuntimeHealth(providerId: string): Promise<ProviderRuntimeState>;
  stopProviderRuntime(providerId: string): Promise<ProviderRuntimeState>;
  cancelProviderRuntime(providerId: string): Promise<boolean>;
  onProviderEvent(listener: (event: ProviderEvent) => void): () => void;
  onProviderRuntimeEvent(listener: (event: ProviderRuntimeEvent) => void): () => void;
  getAppSettings(): Promise<AppSettings>;
  updateAppSettings(partial: Partial<AppSettings>): Promise<AppSettings>;
  resetAppSettings(): Promise<AppSettings>;
}

declare global {
  interface Window {
    triMusicAgent: TriMusicAgentApi;
  }
}

export { };
