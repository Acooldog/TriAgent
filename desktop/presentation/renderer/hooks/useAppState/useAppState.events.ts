/** Agent event listeners — extracted from useAppState for cohesion.
 *
 * Registers the three big IPC event listeners (model events, worker events,
 * session warnings) as hooks that each return a cleanup function. useAppState
 * composes them back into its lifecycle.
 */
import { useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { BatchProgressState, HistoryItem, LlmMessage, ToolEvent, AgentSegment } from "./useAppState.types";

interface ModelEventDeps {
  llmRequestIdRef: React.MutableRefObject<string | null>;
  llmTextRef: React.MutableRefObject<string>;
  llmReasoningRef: React.MutableRefObject<string>;
  setLlmStreaming: (v: { text: string; index: number } | null) => void;
  setLlmThinking: (v: boolean) => void;
  setLlmMessages: Dispatch<SetStateAction<LlmMessage[]>>;
  setLlmTested: (v: boolean) => void;
  showToast: (msg: string) => void;
  setToolEvents: Dispatch<SetStateAction<ToolEvent[]>>;
}

export function useModelEventListener(deps: ModelEventDeps) {
  const { llmRequestIdRef, llmTextRef, llmReasoningRef, setLlmStreaming, setLlmThinking, setLlmMessages, setLlmTested, showToast } = deps;
  return useEffect(() => {
    let active = true;
    const cleanup = window.triMusicAgent.onModelEvent((payload: { requestId: string; event: { type: string; text?: string; message?: string; code?: string; finishReason?: string | null; index?: number; id?: string; name?: string; argumentsDelta?: string; toolCall?: { id: string; name: string; arguments: string; }; retryable?: boolean; status?: number } }) => {
      if (!active) return;
      const { requestId, event } = payload;
      if (requestId !== llmRequestIdRef.current) return;
      if (event.type === "text_delta") {
        const deltaText = event.text ?? "";
        llmTextRef.current += deltaText;
        setLlmThinking(false);
        setLlmStreaming({ text: llmTextRef.current, index: llmTextRef.current.length });
      } else if (event.type === "reasoning_delta") {
        const deltaText = event.text ?? "";
        llmReasoningRef.current += deltaText;
        setLlmThinking(true);
      } else if (event.type === "tool_call_delta" && event.name) {
        setLlmThinking(false);
        const toolName = event.name;
        setToolEventsInline(deps.setToolEvents, toolName);
      } else if (event.type === "tool_call_accepted" && event.toolCall) {
        const toolName = event.toolCall.name;
        deps.setToolEvents((events) => events.map((e) => e.name === toolName ? { ...e, status: "done", detail: `已批准: ${e.name}` } : e));
      } else if (event.type === "tool_call_rejected" && event.toolCall) {
        const toolName = event.toolCall.name;
        deps.setToolEvents((events) => events.map((e) => e.name === toolName ? { ...e, status: "done", detail: `已拒绝: ${event.message ?? ""}` } : e));
      } else if (event.type === "response_completed") {
        setLlmStreaming(null);
        setLlmThinking(false);
        const finalText = llmTextRef.current || llmReasoningRef.current || "连接测试成功";
        setLlmMessages((prev) => [...prev.filter((m) => m.role !== "notice"), { role: "assistant", text: finalText }]);
        setLlmTested(true);
        llmRequestIdRef.current = null;
      } else if (event.type === "error") {
        setLlmStreaming(null);
        setLlmThinking(false);
        setLlmMessages((prev) => [...prev.filter((m) => m.role !== "notice"), { role: "error", text: event.message || "连接失败" }]);
        llmRequestIdRef.current = null;
        showToast(`连接失败：${event.message || "未知错误"}`);
      }
    });
    return () => { active = false; cleanup(); };
  }, [deps]);
}

function setToolEventsInline(setToolEvents: React.Dispatch<React.SetStateAction<ToolEvent[]>>, toolName: string) {
  setToolEvents((events) => {
    const existing = events.find((e) => e.name === toolName && e.status === "running");
    if (existing) return events;
    return [...events, { name: toolName, detail: `工具调用中: ${toolName}`, status: "running" }];
  });
}

interface WorkerEventDeps {
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

export function useWorkerEventListener(deps: WorkerEventDeps) {
  return useEffect(() => {
    let active = true;
    const cleanup = window.triMusicAgent.onWorkerEvent((event: { request_id: string; task_id: string; event_type: string; status: string; payload: Record<string, unknown>; error: { code: string; message: string } | null }) => {
      if (!active) return;
      if (event.task_id !== deps.agentTaskIdRef.current) return;
      const { event_type: eventType, payload, status } = event;
      handleWorkerEvent({ deps, eventType, payload, status, event });
    });
    return () => { active = false; cleanup(); };
  }, [deps]);
}

function handleWorkerEvent(args: { deps: WorkerEventDeps; eventType: string; payload: Record<string, unknown>; status: string; event: any }) {
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
      deps.setAgentMessages((prev) => [...prev, { role: "notice", text: "Agent 已启动，正在连接模型和加载工具..." }]);
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
      deps.setAgentMessages((prev) => [...prev, { role: "notice", text: `已加载 ${tools.length} 个工具: ${tools.join(", ")}` }]);
      break;
    }
    case "agent_tool_call": {
      const toolName = String(payload.tool_name ?? "unknown");
      const toolInput = String(payload.tool_input ?? "");
      const toolResult = String(payload.tool_result ?? "");
      const elapsedSec = Number(payload.elapsed_sec ?? 0);
      const step = Number(payload.step ?? 0);
      const hasResult = toolResult && toolResult !== "执行中...";

      // --- ToolEvent (for ExecutionPanel compatibility) ---
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

      // --- AgentSegment (for segmented execution UI) ---
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
    case "batch_started": {
      const platformId = String(payload.platform_id ?? "");
      deps.setBatchProgress({
        active: true, kind: "decrypt",
        platformId: platformId || undefined,
        inputPath: String(payload.input_path ?? ""),
        outputDir: String(payload.output_dir ?? ""),
        totalCount: Number(payload.candidate_count ?? 0),
        currentIndex: 0,
        currentProgress: 0,
        currentStage: "scanning",
        successCount: 0, skippedCount: 0, failedCount: 0,
        finished: false,
      });
      break;
    }
    case "file_started": {
      const idx = Number(payload.index ?? 0);
      const total = Number(payload.total ?? 1);
      deps.setBatchProgress((prev) => ({
        ...prev,
        active: true,
        currentIndex: idx,
        currentProgress: 0,
        currentFile: String(payload.input_path ?? "").split(/[\\/]/).pop() || "",
        currentStage: "decrypting",
        totalCount: total || prev.totalCount,
      }));
      break;
    }
    case "batch_transcode_progress": {
      const idx = Number(payload.index ?? 0);
      const total = Number(payload.total ?? 1);
      deps.setBatchProgress((prev) => ({
        ...prev,
        active: true,
        currentIndex: idx,
        currentProgress: 60, // transcode mid-point heuristic
        currentFile: String(payload.input_path ?? "").split(/[\\/]/).pop() || prev.currentFile,
        currentStage: "transcoding",
        totalCount: total || prev.totalCount,
      }));
      break;
    }
    case "file_finished": {
      const result = String(payload.result ?? "ok");
      deps.setBatchProgress((prev) => {
        const success = prev.successCount + (result === "ok" ? 1 : 0);
        const skipped = prev.skippedCount + (result === "already_decrypted" || result === "skipped" ? 1 : 0);
        const failed = prev.failedCount + (result === "failed" ? 1 : 0);
        return {
          ...prev,
          active: true,
          currentProgress: 100,
          currentStage: "verifying",
          successCount: success, skippedCount: skipped, failedCount: failed,
        };
      });
      break;
    }
    case "batch_finished": {
      const resultCode = String(payload.result_code ?? "");
      const successCount = Number(payload.success_count ?? 0);
      const failedCount = Number(payload.failed_count ?? 0);
      const skippedCount = Number(payload.skipped_count ?? 0);
      deps.setBatchProgress({
        active: true, kind: "decrypt",
        platformId: String(payload.platform_id ?? undefined),
        totalCount: Number(payload.candidate_count ?? 0),
        currentIndex: Number(payload.candidate_count ?? 0),
        currentProgress: 100,
        currentStage: "done",
        currentFile: undefined,
        successCount, skippedCount, failedCount,
        finished: true,
        finalStatus: resultCode === "ok" || (failedCount === 0 && successCount > 0) ? "completed" : "failed",
        finalMessage: `解密完成：成功 ${successCount}，跳过 ${skippedCount}，失败 ${failedCount}`,
      });
      break;
    }
    case "agent_step_failed": {
      const errorMsg = String(payload.error ?? "未知错误");
      deps.setToolEvents((prev) => prev.map((t) => t.status === "running" ? { ...t, status: "error" as const, detail: `失败: ${errorMsg}` } : t));
      deps.setAgentMessages((prev) => [...prev, { role: "error", text: `工具执行失败: ${errorMsg}` }]);
      break;
    }
    case "agent_message": {
      const content = String(payload.content ?? "");
      if (content) {
        const isToolAction = deps.toolActionPattern.test(content);
        deps.setAgentMessages((prev) => [...prev, { role: (isToolAction ? "notice" : "assistant") as LlmMessage["role"], text: content }]);
        // Thinking/progress messages → create thinking segment (only if it looks like planning/thinking text)
        if (String(payload.kind ?? "") === "progress" || (!isToolAction && content.length < 200)) {
          deps.setAgentSegments((prev) => {
            // Merge consecutive thinking segments by appending content to last one
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
        deps.setAgentMessages((prev) => [...prev, { role: "error", text: errMsg }]);
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
      deps.setAgentMessages((prev) => [...prev, { role: "error", text: `Agent 错误: ${errMsg}` }]);
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
  }
}

export function useSessionWarningListener(showToast: (msg: string) => void) {
  return useEffect(() => {
    let active = true;
    const cleanup = window.triMusicAgent.onSessionPersistenceWarning((payload: { requestId: string; message: string }) => {
      if (!active) return;
      console.warn("[useAppState] session-persistence-warning:", payload.message);
      showToast(payload.message);
    });
    return () => { active = false; cleanup(); };
  }, [showToast]);
}
