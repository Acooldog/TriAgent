/** Agent event listeners — extracted from useAppState for cohesion.
 *
 * Registers the three big IPC event listeners (model events, worker events,
 * session warnings) as hooks that each return a cleanup function. useAppState
 * composes them back into its lifecycle.
 */
import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { LlmMessage, ToolEvent } from "./useAppState.types";
import { handleWorkerEvent, type WorkerEventDeps } from "./events/workerEventHandlers";

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

export function useWorkerEventListener(deps: WorkerEventDeps) {
  return useEffect(() => {
    let active = true;
    const cleanup = window.triMusicAgent.onWorkerEvent((event: { request_id: string; task_id: string; event_type: string; status: string; payload: Record<string, unknown>; error: { code: string; message: string } | null }) => {
      if (!active) return;
      if (event.task_id !== deps.agentTaskIdRef.current) {
        console.warn("[worker_event] task_id mismatch", {
          event_task_id: event.task_id,
          current_task_id: deps.agentTaskIdRef.current,
          event_type: event.event_type,
        });
        return;
      }
      const { event_type: eventType, payload, status } = event;
      if (eventType === "agent_tool_call") {
        console.log("[worker_event] agent_tool_call passed filter", { task_id: event.task_id });
      }
      handleWorkerEvent({ deps, eventType, payload, status, event });
    });
    return () => { active = false; cleanup(); };
  }, [deps]);
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
