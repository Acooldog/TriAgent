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

// NOTE: UseAppStateResult is defined in useAppState.ts via ReturnType,
// re-exported from there for consumers.
