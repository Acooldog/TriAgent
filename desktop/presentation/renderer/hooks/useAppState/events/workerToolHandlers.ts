/** workerToolHandlers — Agent 工具调用事件处理器。
 *
 * 处理 agent_tool_call, agent_step_finished, agent_step_failed 事件。
 */
import type { Dispatch, SetStateAction } from "react";
import type { ToolEvent } from "../useAppState.types";
import type {
    AgentMessageDeps,
    ToolCallDeps,
} from "./workerEventDeps";
import {
    buildSegmentContent,
    buildToolCallDetail,
    buildToolEventSummary,
} from "./workerEventTypes";

/** agent_tool_call — 工具调用进度卡片。 */
export function handleAgentToolCall(
    deps: ToolCallDeps & { setProgress: Dispatch<SetStateAction<number>> },
    payload: Record<string, unknown>,
): void {
    console.log("[agent_tool_call] received", {
        tool_name: payload.tool_name,
        tool_input: String(payload.tool_input ?? "").slice(0, 100),
        tool_result: String(payload.tool_result ?? "").slice(0, 100),
        step: payload.step,
        keys: Object.keys(payload),
    });
    const detail = buildToolCallDetail(payload);
    const segmentContent = buildSegmentContent(detail, payload);

    // 结束思考段
    deps.setAgentSegments((prev) =>
        prev.map((s) =>
            s.type === "thinking" && s.status === "running"
                ? { ...s, status: "done" as const, finishedAt: Date.now() }
                : s,
        ),
    );

    // 更新/创建工具事件
    deps.setToolEvents((prev) => {
        const existingIdx = prev.findIndex(
            (t) => t.step === detail.step && t.name === detail.toolName,
        );
        if (existingIdx >= 0) {
            const summary = buildToolEventSummary(
                detail,
                payload,
                prev[existingIdx].detail,
            );
            const updated = [...prev];
            updated[existingIdx] = {
                ...updated[existingIdx],
                detail: summary.detail,
                status: summary.status,
                toolResult: summary.toolResult,
                elapsedSec: summary.elapsedSec,
            };
            return updated;
        }
        return [
            ...prev,
            {
                name: detail.toolName,
                detail: detail.actionText || `输入: ${detail.inputSummary}`,
                status: "running" as const,
                toolResult: String(payload.tool_result ?? "").slice(0, 200),
                elapsedSec: detail.elapsedSec,
                step: detail.step,
            } as ToolEvent,
        ];
    });

    deps.setProgress((prev) => Math.min(90, prev + 8));

    // 更新/创建 Agent 段
    deps.setAgentSegments((prev) => {
        const segId = `tool-${detail.toolName}-${detail.step}`;
        const existing = prev.findIndex((s) => s.id === segId);
        const now = Date.now();
        if (existing >= 0) {
            const updated = [...prev];
            updated[existing] = {
                ...updated[existing],
                status: detail.status,
                title: segmentContent.title,
                content: segmentContent.body,
                toolResult: segmentContent.toolResult,
                elapsedSec: segmentContent.elapsedSec,
                finishedAt: detail.hasResult ? now : undefined,
            };
            return updated;
        }
        return [
            ...prev,
            {
                id: segId,
                type: "tool_call",
                status: detail.status,
                title: segmentContent.title,
                content: segmentContent.body,
                createdAt: now,
                finishedAt: detail.hasResult ? now : undefined,
                toolName: detail.toolName,
                toolArgs: String(payload.tool_input ?? "").slice(0, 200),
                toolResult: segmentContent.toolResult,
                elapsedSec: segmentContent.elapsedSec,
            },
        ];
    });
}

/** agent_step_finished — 步骤完成。 */
export function handleAgentStepFinished(
    deps: ToolCallDeps & {
        setProgress: Dispatch<SetStateAction<number>>;
        setStepIndex: Dispatch<SetStateAction<number>>;
    },
    payload: Record<string, unknown>,
): void {
    const step = Number(payload.step ?? 0);
    const elapsedSec = Number(payload.elapsed_sec ?? 0);
    deps.setToolEvents((prev) =>
        prev.map((t) =>
            t.status === "running"
                ? {
                    ...t,
                    status: "done" as const,
                    detail: t.toolResult ? `完成 (${elapsedSec}s)` : t.detail,
                }
                : t,
        ),
    );
    deps.setAgentSegments((prev) =>
        prev.map((s) =>
            s.status === "running"
                ? { ...s, status: "done", finishedAt: Date.now() }
                : s,
        ),
    );
    deps.setStepIndex((prev) => Math.max(step, prev));
    deps.setProgress((prev) => Math.min(95, prev + 15));
}

/** agent_step_failed — 步骤失败。 */
export function handleAgentStepFailed(
    deps: ToolCallDeps & AgentMessageDeps,
    payload: Record<string, unknown>,
): void {
    const errorMsg = String(payload.error ?? "未知错误");
    deps.setToolEvents((prev) =>
        prev.map((t) =>
            t.status === "running"
                ? { ...t, status: "error" as const, detail: `失败: ${errorMsg}` }
                : t,
        ),
    );
    deps.setAgentMessages((prev) => [
        ...prev,
        { role: "error", text: `工具执行失败: ${errorMsg}`, createdAt: Date.now() },
    ]);
}

export const __allTool = {
    handleAgentToolCall,
    handleAgentStepFinished,
    handleAgentStepFailed,
};
