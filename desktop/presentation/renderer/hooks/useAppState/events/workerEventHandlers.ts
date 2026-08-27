/** Worker event handlers — extracted from useAppState.events.ts for SRP.
 *
 * Handles the switch-case dispatch for worker agent events.
 */
import type { Dispatch, SetStateAction } from "react";
import type { BatchProgressState, HistoryItem, LlmMessage, ToolEvent, AgentSegment } from "../useAppState.types";
import { handleBatchEvent } from "./batchEventHandlers";

export interface WorkerEventDeps {
  agentTaskIdRef: React.MutableRefObject<string | null>;
  showToast: (msg: string) => void;
  setToolEvents: Dispatch<SetStateAction<ToolEvent[]>>;
  setAgentMessages: Dispatch<SetStateAction<LlmMessage[]>>;
  setAgentQuestion: (v: any) => void;
  setHistory: Dispatch<SetStateAction<HistoryItem[]>>;
  setProcessing: Dispatch<SetStateAction<boolean>>;
  setProgress: Dispatch<SetStateAction<number>>;
  setStepIndex: Dispatch<SetStateAction<number>>;
  setTaskStatus: Dispatch<SetStateAction<string>>;
  toolActionPattern: RegExp;
  setBatchProgress: Dispatch<SetStateAction<BatchProgressState>>;
  setAgentSegments: Dispatch<SetStateAction<AgentSegment[]>>;
}

export function handleWorkerEvent(args: { deps: WorkerEventDeps; eventType: string; payload: Record<string, unknown>; status: string; event: any }) {
  const { deps, eventType, payload, status, event } = args;
  switch (eventType) {
    case "agent_log": {
      const level = String(payload.level ?? "info");
      const message = String(payload.message ?? "");
      if (message) console.info(`[Agent.${level}]`, message);
      break;
    }
    case "agent_started": {
      const taskId = String(event.task_id ?? "");
      deps.setToolEvents([]);
      deps.setAgentSegments([]);
      deps.setAgentMessages((prev) => [...prev, { role: "notice", text: "Agent 已启动，正在连接模型和加载工具...", createdAt: Date.now() }]);
      if (taskId) {
        deps.setAgentMessages((prev) => {
          const userMsg = prev.find((m) => m.role === "user");
          const title = userMsg?.text?.slice(0, 40) || "未命名任务";
          deps.setHistory((h) => {
            const idx = h.findIndex((item) => item.taskId === taskId);
            const newItem: HistoryItem = {
              id: `hist_${taskId}`,
              title,
              date: new Date().toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }),
              total: 0, time: "", success: 0, failed: 0, status: "处理中",
              messages: prev, taskId,
            };
            if (idx >= 0) { const updated = [...h]; updated[idx] = { ...updated[idx], ...newItem }; return updated; }
            return [newItem, ...h];
          });
          return prev;
        });
      }
      break;
    }
    case "agent_ready": {
      const tools = Array.isArray(payload.tools) ? (payload.tools as string[]) : [];
      deps.setAgentMessages((prev) => [...prev, { role: "notice", text: `已加载 ${tools.length} 个工具: ${tools.join(", ")}`, createdAt: Date.now() }]);
      break;
    }
    case "agent_tool_call": {
      const toolName = String(payload.tool_name ?? "unknown");
      const toolInput = String(payload.tool_input ?? "");
      const toolResult = String(payload.tool_result ?? "");
      const elapsedSec = Number(payload.elapsed_sec ?? 0);
      const step = Number(payload.step ?? 0);
      const hasResult = toolResult && toolResult !== "执行中...";

      deps.setAgentSegments((prev) =>
        prev.map((s) =>
          s.type === "thinking" && s.status === "running"
            ? { ...s, status: "done" as const, finishedAt: Date.now() }
            : s
        )
      );

      deps.setToolEvents((prev) => {
        const existingIdx = prev.findIndex((t) => t.step === step && t.name === toolName);
        if (existingIdx >= 0) {
          const updated = [...prev];
          updated[existingIdx] = {
            ...updated[existingIdx],
            toolResult: toolResult.slice(0, 200),
            detail: hasResult ? (toolInput ? `输入: ${toolInput.slice(0, 60)} — 完成` : "执行完成") : updated[existingIdx].detail,
            status: hasResult ? "done" as const : "running" as const,
            elapsedSec,
          };
          return updated;
        }
        return [...prev, { name: toolName, detail: toolInput ? `输入: ${toolInput.slice(0, 60)}` : "执行中", status: "running" as const, toolResult: toolResult.slice(0, 200), elapsedSec, step } as ToolEvent];
      });
      deps.setProgress((prev) => Math.min(90, prev + 8));

      deps.setAgentSegments((prev) => {
        const segId = `tool-${toolName}-${step}`;
        const existing = prev.findIndex((s) => s.id === segId);
        const now = Date.now();
        const title = `调用 ${toolName}`;
        const content = toolInput
          ? `参数: ${toolInput.slice(0, 200)}${toolInput.length > 200 ? "..." : ""}${hasResult ? `\n\n结果: ${toolResult.slice(0, 300)}${toolResult.length > 300 ? "..." : ""}` : ""}`
          : hasResult ? `结果: ${toolResult.slice(0, 300)}${toolResult.length > 300 ? "..." : ""}` : "执行中...";
        if (existing >= 0) {
          const updated = [...prev];
          updated[existing] = {
            ...updated[existing],
            status: hasResult ? "done" : "running",
            content,
            toolResult: hasResult ? toolResult.slice(0, 500) : undefined,
            elapsedSec,
            finishedAt: hasResult ? now : undefined,
          };
          return updated;
        }
        return [...prev, {
          id: segId, type: "tool_call", status: hasResult ? "done" : "running",
          title, content, createdAt: now, finishedAt: hasResult ? now : undefined,
          toolName, toolArgs: toolInput.slice(0, 200), toolResult: hasResult ? toolResult.slice(0, 500) : undefined,
          elapsedSec,
        }];
      });
      break;
    }
    case "agent_step_finished": {
      const step = Number(payload.step ?? 0);
      const elapsedSec = Number(payload.elapsed_sec ?? 0);
      deps.setToolEvents((prev) => prev.map((t) => t.status === "running" ? { ...t, status: "done" as const, detail: t.toolResult ? `完成 (${elapsedSec}s)` : t.detail } : t));
      deps.setAgentSegments((prev) => prev.map((s) => s.status === "running" ? { ...s, status: "done", finishedAt: Date.now() } : s));
      deps.setStepIndex((prev) => Math.max(step, prev));
      deps.setProgress((prev) => Math.min(95, prev + 15));
      break;
    }
    case "agent_step_failed": {
      const errorMsg = String(payload.error ?? "未知错误");
      deps.setToolEvents((prev) => prev.map((t) => t.status === "running" ? { ...t, status: "error" as const, detail: `失败: ${errorMsg}` } : t));
      deps.setAgentMessages((prev) => [...prev, { role: "error", text: `工具执行失败: ${errorMsg}`, createdAt: Date.now() }]);
      break;
    }
    case "agent_message": {
      const content = String(payload.content ?? "");
      if (content) {
        const isToolAction = deps.toolActionPattern.test(content);
        const isNotice = isToolAction || String(payload.kind ?? "") === "progress";

        deps.setAgentMessages((prev) => {
          if (!isNotice) {
            const last = prev[prev.length - 1];
            if (last && last.role === "assistant") {
              const updated = [...prev];
              updated[prev.length - 1] = { ...last, text: content, createdAt: Date.now() };
              return updated;
            }
          }
          return [...prev, { role: (isNotice ? "notice" : "assistant") as LlmMessage["role"], text: content, createdAt: Date.now() }];
        });

        if (String(payload.kind ?? "") === "progress" && !isToolAction) {
          deps.setAgentSegments((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.type === "thinking" && last.status === "running") {
              const updated = [...prev];
              updated[prev.length - 1] = { ...last, content: last.content + "\n" + content };
              return updated;
            }
            return [...prev, {
              id: `thinking-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              type: "thinking", status: "running",
              title: "思考中", content, createdAt: Date.now(),
            }];
          });
        }
      }
      break;
    }
    case "agent_question": {
      const questionId = String(payload.question_id ?? "");
      const question = String(payload.question ?? "");
      const optionsRaw = Array.isArray(payload.options) ? (payload.options as unknown[]) : [];
      const options = optionsRaw.map((o) => String(o)).filter((o) => o.trim().length > 0);
      if (questionId && question && options.length >= 2) {
        deps.setAgentQuestion({ questionId, question, options });
      }
      break;
    }
    case "agent_finished": {
      const finalStatus = String(payload.status ?? status);
      const taskId = String(event.task_id ?? "");
      deps.setProcessing(false);
      deps.setProgress(100);
      deps.setTaskStatus(finalStatus === "completed" ? "成功" : "失败");
      deps.setToolEvents((prev) => prev.map((t) => t.status === "running" ? { ...t, status: "done" } : t));
      deps.setAgentSegments((prev) => prev.map((s) => s.status === "running" ? { ...s, status: "done", finishedAt: Date.now() } : s));
      deps.setAgentQuestion(null);
      deps.agentTaskIdRef.current = null;
      if (finalStatus !== "completed") {
        const errMsg = String(event.error?.message ?? "Agent 执行失败");
        deps.setAgentMessages((prev) => [...prev, { role: "error", text: errMsg, createdAt: Date.now() }]);
      }
      deps.showToast(finalStatus === "completed" ? "Agent 任务已完成" : `任务失败: ${finalStatus}`);
      deps.setAgentMessages((prev) => {
        const currentMessages = [...prev];
        const title = currentMessages.find((m) => m.role === "user")?.text?.slice(0, 40) || "未命名任务";
        const newItem: HistoryItem = {
          id: taskId ? `hist_${taskId}` : `hist_${Date.now()}`,
          title,
          date: new Date().toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }),
          total: 0, time: "",
          success: finalStatus === "completed" ? 1 : 0,
          failed: finalStatus === "failed" ? 1 : 0,
          status: finalStatus === "completed" ? "成功" : finalStatus === "cancelled" ? "已停止" : "失败",
          messages: currentMessages,
          taskId: taskId || undefined,
        };
        deps.setHistory((h) => {
          const idx = h.findIndex((item) => item.taskId === taskId);
          if (idx >= 0) { const updated = [...h]; updated[idx] = { ...updated[idx], ...newItem }; return updated; }
          return [newItem, ...h];
        });
        return currentMessages;
      });
      break;
    }
    case "agent_error": {
      const errMsg = String(payload.error ?? "未知错误");
      deps.setAgentMessages((prev) => [...prev, { role: "error", text: `Agent 错误: ${errMsg}`, createdAt: Date.now() }]);
      break;
    }
    case "agent_warning": {
      const warnMsg = String(payload.message ?? "");
      if (warnMsg) deps.showToast(warnMsg);
      break;
    }
    case "worker_finished": {
      deps.agentTaskIdRef.current = null;
      break;
    }
    default: {
      if (eventType.startsWith("batch_") || eventType.startsWith("file_")) {
        handleBatchEvent(eventType, payload, { setBatchProgress: deps.setBatchProgress });
      }
      break;
    }
  }
}
