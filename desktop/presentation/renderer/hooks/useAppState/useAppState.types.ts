export type Page = "dashboard" | "llm" | "task" | "library" | "history" | "diagnostics" | "settings" | "recovery";

export interface FileItem {
  id: string;
  title: string;
  artist: string;
  platform: string;
  input: string;
  output: string;
  status: string;
  size: string;
  cover: string;
}

export interface HistoryItem {
  id: string;
  title: string;
  date: string;
  total: number;
  time: string;
  success: number;
  failed: number;
  status: string;
  messages?: LlmMessage[];
  taskId?: string;
}

export interface LlmMessage {
  role: "user" | "assistant" | "error" | "notice";
  text: string;
}

export interface AgentQuestion {
  questionId: string;
  question: string;
  options: string[];
}

export interface ToolEvent {
  name: string;
  detail: string;
  status: "done" | "running" | "pending" | "error";
  toolResult?: string;
  elapsedSec?: number;
  step?: number;
}

export interface BatchProgressState {
  active: boolean;
  kind: "decrypt" | "transcode" | "copy" | "generic";
  platformId?: string;
  inputPath?: string;
  outputDir?: string;
  totalCount: number;
  currentIndex: number;
  currentFile?: string;
  currentStage?: "scanning" | "decrypting" | "transcoding" | "verifying" | "done" | "failed";
  currentProgress: number; // 0-100 for the single-file bar
  successCount: number;
  skippedCount: number;
  failedCount: number;
  finished: boolean;
  finalStatus?: "completed" | "failed" | "cancelled";
  finalMessage?: string;
}

export type AgentSegmentType = "thinking" | "tool_call" | "result";
export type AgentSegmentStatus = "running" | "done" | "error";

export interface AgentSegment {
  id: string;
  type: AgentSegmentType;
  status: AgentSegmentStatus;
  title: string;
  content: string;
  createdAt: number;
  finishedAt?: number;
  toolName?: string;
  toolArgs?: string;
  toolResult?: string;
  elapsedSec?: number;
}

// NOTE: UseAppStateResult is defined in useAppState.ts via ReturnType,
// re-exported from there for consumers.
