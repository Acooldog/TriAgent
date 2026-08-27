/** workerEventTypes — Agent 事件值对象类型。
 *
 * Primitive Obsession 修复：将裸字符串 detail/title/content
 * 替换为结构化值对象，封装截断、格式化等业务规则。
 */

/** 工具调用详情值对象。 */
export interface ToolCallDetail {
  /** 工具名 */
  readonly toolName: string;
  /** 操作说明（来自 action_text） */
  readonly actionText: string;
  /** 输入摘要（截断至 60 字符） */
  readonly inputSummary: string;
  /** 是否已有结果 */
  readonly hasResult: boolean;
  /** 结果文本（截断至 300 字符） */
  readonly resultSummary: string;
  /** 耗时（秒） */
  readonly elapsedSec: number;
  /** 步骤序号 */
  readonly step: number;
  /** 状态 */
  readonly status: "running" | "done" | "error";
}

export function buildToolCallDetail(
  payload: Record<string, unknown>,
): ToolCallDetail {
  const toolName = String(payload.tool_name ?? "unknown");
  const toolInput = String(payload.tool_input ?? "");
  const toolResult = String(payload.tool_result ?? "");
  const elapsedSec = Number(payload.elapsed_sec ?? 0);
  const step = Number(payload.step ?? 0);
  const actionText = String(payload.action_text ?? "");
  const hasResult = !!(toolResult && toolResult !== "执行中...");

  return {
    toolName,
    actionText,
    inputSummary: toolInput.slice(0, 60),
    hasResult,
    resultSummary: toolResult.slice(0, 300),
    elapsedSec,
    step,
    status: hasResult ? "done" : "running",
  };
}

/** Agent 段内容值对象。 */
export interface SegmentContent {
  readonly title: string;
  readonly body: string;
  readonly toolResult?: string;
  readonly elapsedSec: number;
}

export function buildSegmentContent(
  detail: ToolCallDetail,
  payload: Record<string, unknown>,
): SegmentContent {
  const toolInput = String(payload.tool_input ?? "");
  const toolResult = String(payload.tool_result ?? "");
  const hasResult = detail.hasResult;

  const title = detail.actionText || `调用 ${detail.toolName}`;

  let body: string;
  if (toolInput) {
    body = `参数: ${toolInput.slice(0, 200)}${toolInput.length > 200 ? "..." : ""}`;
    if (hasResult) {
      body += `\n\n结果: ${toolResult.slice(0, 300)}${toolResult.length > 300 ? "..." : ""}`;
    }
  } else if (hasResult) {
    body = `结果: ${toolResult.slice(0, 300)}${toolResult.length > 300 ? "..." : ""}`;
  } else {
    body = "执行中...";
  }

  return {
    title,
    body,
    toolResult: hasResult ? toolResult.slice(0, 500) : undefined,
    elapsedSec: detail.elapsedSec,
  };
}

/** Agent 消息内容值对象。 */
export interface AgentMessageContent {
  readonly text: string;
  readonly isNotice: boolean;
  readonly isToolAction: boolean;
  readonly role: "assistant" | "notice" | "error";
}

export function buildAgentMessageContent(
  payload: Record<string, unknown>,
  toolActionPattern: RegExp,
): AgentMessageContent {
  const content = String(payload.content ?? "");
  const isToolAction = toolActionPattern.test(content);
  const isNotice = isToolAction || String(payload.kind ?? "") === "progress";
  const kind = String(payload.kind ?? "");

  let role: "assistant" | "notice" | "error" = "assistant";
  if (isNotice) {
    role = "notice";
  } else if (kind === "progress" && !isToolAction) {
    role = "notice";
  }

  return {
    text: content,
    isNotice,
    isToolAction,
    role,
  };
}

/** 工具事件卡片摘要（值对象）。 */
export interface ToolEventSummary {
  readonly detail: string;
  readonly status: "done" | "running" | "error";
  readonly toolResult: string;
  readonly elapsedSec: number;
}

export function buildToolEventSummary(
  detail: ToolCallDetail,
  payload: Record<string, unknown>,
  existingDetail?: string,
): ToolEventSummary {
  const toolInput = String(payload.tool_input ?? "");
  const toolResult = String(payload.tool_result ?? "");
  const hasResult = detail.hasResult;

  const newDetail = hasResult
    ? toolInput
      ? `输入: ${detail.inputSummary} — 完成`
      : "执行完成"
    : existingDetail ?? `输入: ${detail.inputSummary}`;

  return {
    detail: newDetail,
    status: hasResult ? "done" : "running",
    toolResult: toolResult.slice(0, 200),
    elapsedSec: detail.elapsedSec,
  };
}

/** 思考段内容值对象 — 直接使用 AgentSegment 类型。 */
export function buildThinkingSegment(content: string): import("../useAppState.types").AgentSegment {
  return {
    id: `thinking-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: "thinking",
    status: "running",
    title: "思考中",
    content,
    createdAt: Date.now(),
  };
}

export const TOOL_EVENT_TITLE = {
  ACTION_TEXT: "actionText",
  DEFAULT_PREFIX: "调用 ",
  EXECUTING: "执行中",
  EXECUTING_DOTS: "执行中...",
  COMPLETED: "执行完成",
  INPUT: "输入: ",
  RESULT: "结果: ",
  PARAM: "参数: ",
} as const;
