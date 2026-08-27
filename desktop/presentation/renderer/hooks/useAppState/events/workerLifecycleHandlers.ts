/** workerLifecycleHandlers — Agent 生命周期事件处理器。
 *
 * 处理 agent_log, agent_started, agent_ready, agent_finished,
 * agent_error, agent_warning, worker_finished 等生命周期事件。
 */
import type { Dispatch, SetStateAction } from "react";
import type {
    HistoryItem,
    LlmMessage,
} from "../useAppState.types";
import type {
    AgentLifecycleDeps,
    AgentMessageDeps,
    ToolCallDeps,
    WorkerEventDeps,
} from "./workerEventDeps";

/** agent_log — 仅打印日志。 */
export function handleAgentLog(
    _deps: WorkerEventDeps,
    payload: Record<string, unknown>,
): void {
    const level = String(payload.level ?? "info");
    const message = String(payload.message ?? "");
    if (message) console.info(`[Agent.${level}]`, message);
}

/** agent_started — 初始化状态，记录历史。 */
export function handleAgentStarted(
    deps: AgentLifecycleDeps & ToolCallDeps & AgentMessageDeps,
    _payload: Record<string, unknown>,
    event: Record<string, unknown>,
): void {
    const taskId = String(event.task_id ?? "");
    deps.setToolEvents([]);
    deps.setAgentSegments([]);
    deps.setAgentMessages((prev) => [
        ...prev,
        { role: "notice", text: "Agent 已启动，正在连接模型和加载工具...", createdAt: Date.now() },
    ]);
    if (taskId) {
        deps.setAgentMessages((prev) => {
            const userMsg = prev.find((m) => m.role === "user");
            const title = userMsg?.text?.slice(0, 40) || "未命名任务";
            deps.setHistory((h) => {
                const idx = h.findIndex((item) => item.taskId === taskId);
                const newItem: HistoryItem = {
                    id: `hist_${taskId}`,
                    title,
                    date: new Date().toLocaleString("zh-CN", {
                        month: "2-digit",
                        day: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                    }),
                    total: 0,
                    time: "",
                    success: 0,
                    failed: 0,
                    status: "处理中",
                    messages: prev,
                    taskId,
                };
                if (idx >= 0) {
                    const updated = [...h];
                    updated[idx] = { ...updated[idx], ...newItem };
                    return updated;
                }
                return [newItem, ...h];
            });
            return prev;
        });
    }
}

/** agent_ready — 显示已加载工具。 */
export function handleAgentReady(
    deps: AgentMessageDeps,
    payload: Record<string, unknown>,
): void {
    const tools = Array.isArray(payload.tools)
        ? (payload.tools as string[])
        : [];
    deps.setAgentMessages((prev) => [
        ...prev,
        {
            role: "notice",
            text: `已加载 ${tools.length} 个工具: ${tools.join(", ")}`,
            createdAt: Date.now(),
        },
    ]);
}

/** agent_finished — 任务结束。 */
export function handleAgentFinished(
    deps: WorkerEventDeps,
    payload: Record<string, unknown>,
    event: Record<string, unknown>,
): void {
    const finalStatus = String(payload.status ?? "");
    const taskId = String(event.task_id ?? "");
    const isCompleted = finalStatus === "completed";

    deps.setProcessing(false);
    deps.setProgress(100);
    deps.setTaskStatus(isCompleted ? "成功" : "失败");
    deps.setToolEvents((prev) =>
        prev.map((t) => (t.status === "running" ? { ...t, status: "done" } : t)),
    );
    deps.setAgentSegments((prev) =>
        prev.map((s) => (s.status === "running" ? { ...s, status: "done", finishedAt: Date.now() } : s)),
    );
    deps.setAgentQuestion(null);
    deps.agentTaskIdRef.current = null;

    if (!isCompleted) {
        const errMsg = String(
            ((event.error as Record<string, unknown>)?.message ?? "Agent 执行失败"),
        );
        deps.setAgentMessages((prev) => [
            ...prev,
            { role: "error", text: errMsg, createdAt: Date.now() },
        ]);
    }

    deps.showToast(isCompleted ? "Agent 任务已完成" : `任务失败: ${finalStatus}`);

    deps.setAgentMessages((prev) => {
        const currentMessages = [...prev];
        const title =
            currentMessages.find((m) => m.role === "user")?.text?.slice(0, 40) ||
            "未命名任务";
        const statusLabel = isCompleted
            ? "成功"
            : finalStatus === "cancelled"
                ? "已停止"
                : "失败";
        const newItem: HistoryItem = {
            id: taskId ? `hist_${taskId}` : `hist_${Date.now()}`,
            title,
            date: new Date().toLocaleString("zh-CN", {
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
            }),
            total: 0,
            time: "",
            success: isCompleted ? 1 : 0,
            failed: finalStatus === "failed" ? 1 : 0,
            status: statusLabel,
            messages: currentMessages,
            taskId: taskId || undefined,
        };
        deps.setHistory((h) => {
            const idx = h.findIndex((item) => item.taskId === taskId);
            if (idx >= 0) {
                const updated = [...h];
                updated[idx] = { ...updated[idx], ...newItem };
                return updated;
            }
            return [newItem, ...h];
        });
        return currentMessages;
    });
}

/** agent_error — 错误事件。 */
export function handleAgentError(
    deps: AgentMessageDeps,
    payload: Record<string, unknown>,
): void {
    const errMsg = String(payload.error ?? "未知错误");
    deps.setAgentMessages((prev) => [
        ...prev,
        { role: "error", text: `Agent 错误: ${errMsg}`, createdAt: Date.now() },
    ]);
}

/** agent_warning — 警告事件。 */
export function handleAgentWarning(
    deps: AgentLifecycleDeps,
    payload: Record<string, unknown>,
): void {
    const warnMsg = String(payload.message ?? "");
    if (warnMsg) deps.showToast(warnMsg);
}

/** worker_finished — Worker 进程结束。 */
export function handleWorkerFinished(deps: AgentLifecycleDeps): void {
    deps.agentTaskIdRef.current = null;
}

export const __allLifecycle = {
    handleAgentLog,
    handleAgentStarted,
    handleAgentReady,
    handleAgentFinished,
    handleAgentError,
    handleAgentWarning,
    handleWorkerFinished,
};
