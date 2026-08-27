/** workerMessageHandlers — Agent 消息/思考事件处理器。
 *
 * 处理 agent_message, agent_question 事件。
 */
import type { LlmMessage } from "../useAppState.types";
import type {
    AgentMessageDeps,
    ToolCallDeps,
} from "./workerEventDeps";
import {
    buildAgentMessageContent,
    buildThinkingSegment,
} from "./workerEventTypes";

/** agent_message — 模型回复。 */
export function handleAgentMessage(
    deps: AgentMessageDeps & ToolCallDeps,
    payload: Record<string, unknown>,
): void {
    const content = String(payload.content ?? "");
    if (!content) return;

    const msgContent = buildAgentMessageContent(payload, deps.toolActionPattern);

    deps.setAgentMessages((prev) => {
        if (!msgContent.isNotice) {
            // 查找最后一条 assistant 消息并替换（跨 notice 卡片）
            const lastAssistantIdx = [...prev]
                .reverse()
                .findIndex((m) => m.role === "assistant");
            if (lastAssistantIdx !== -1) {
                const idx = prev.length - 1 - lastAssistantIdx;
                const updated = [...prev];
                updated[idx] = { ...updated[idx], text: content, createdAt: Date.now() };
                return updated;
            }
        }
        return [
            ...prev,
            {
                role: msgContent.role as LlmMessage["role"],
                text: content,
                createdAt: Date.now(),
            },
        ];
    });

    if (String(payload.kind ?? "") === "progress" && !msgContent.isToolAction) {
        deps.setAgentSegments((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.type === "thinking" && last.status === "running") {
                const updated = [...prev];
                updated[prev.length - 1] = {
                    ...last,
                    content: last.content + "\n" + content,
                };
                return updated;
            }
            return [...prev, buildThinkingSegment(content)];
        });
    }
}

/** agent_question — 向用户提问。 */
export function handleAgentQuestion(
    deps: AgentMessageDeps,
    payload: Record<string, unknown>,
): void {
    const questionId = String(payload.question_id ?? "");
    const question = String(payload.question ?? "");
    const optionsRaw = Array.isArray(payload.options)
        ? (payload.options as unknown[])
        : [];
    const options = optionsRaw
        .map((o) => String(o))
        .filter((o) => o.trim().length > 0);
    if (questionId && question && options.length >= 2) {
        deps.setAgentQuestion({ questionId, question, options });
    }
}

export const __allMessage = {
    handleAgentMessage,
    handleAgentQuestion,
};
