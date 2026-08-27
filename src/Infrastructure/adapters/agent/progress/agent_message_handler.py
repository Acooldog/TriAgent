"""Agent message handler — 流式消息处理、递归错误检测与总结。

从 media/transcode/stream_handler.py 迁移而来，
原位置违反六边形架构（agent 适配器不应依赖 media 适配器）。
"""
from __future__ import annotations

import re
from typing import Any

from src.Infrastructure.adapters.agent.progress.agent_progress import (
    AgentEventEmitter,
    build_tool_action_message,
)

try:
    from langchain_core.messages import AIMessage, AIMessageChunk, ToolMessage
except ImportError:
    class ToolMessage:  # type: ignore[no-redef]
        def __init__(self, content: str, tool_call_id: str = "", name: str = "") -> None:
            self.content = content
            self.tool_call_id = tool_call_id
            self.name = name

    class AIMessage:  # type: ignore[no-redef]
        def __init__(self, content: str = "", tool_calls: list[dict[str, Any]] | None = None) -> None:
            self.content = content
            self.tool_calls = tool_calls or []

    class AIMessageChunk:  # type: ignore[no-redef]
        def __init__(self, content: str = "", tool_calls: list[dict[str, Any]] | None = None) -> None:
            self.content = content
            self.tool_calls = tool_calls or []


# === 智能 delta 模式检测 ===
_DELTA_MODE: str | None = None
_LAST_AI_CONTENT_LEN: int = 0
_CHUNK_COUNT: int = 0  # 用于跳过首个 chunk 的检测


def reset_delta_mode() -> None:
    """每次 stream 调用前重置 delta 检测状态。"""
    global _DELTA_MODE, _LAST_AI_CONTENT_LEN, _CHUNK_COUNT
    _DELTA_MODE = None
    _LAST_AI_CONTENT_LEN = 0
    _CHUNK_COUNT = 0


def _flush_pending_text(
    emitter: AgentEventEmitter,
    pending_text: list[str],
) -> str:
    """flush pending_text —— emit 给前端并清空。"""
    text = "".join(pending_text).strip()
    if text:
        emitter._log(f"Agent 回复: {text[:150]}", "info")
        emitter.emit("agent_message", {
            "content": text,
            "tool_calls_count": 0,
        })
    pending_text.clear()
    return text


def _detect_and_append_delta(
    pending_text: list[str],
    content: str,
    emitter: AgentEventEmitter,
) -> None:
    """智能追加 delta —— 自动检测是增量还是累积模式。

    首个 chunk 不做检测（空串是所有字符串的前缀，必然误判为累积模式），
    从第二个 chunk 开始比较：如果新内容以当前累积文本为前缀→累积模式，
    否则→增量模式。
    """
    global _DELTA_MODE, _LAST_AI_CONTENT_LEN, _CHUNK_COUNT
    if not content:
        return

    _CHUNK_COUNT += 1

    # 首个 chunk：不检测，直接追加
    if _CHUNK_COUNT == 1:
        pending_text.append(content)
        _LAST_AI_CONTENT_LEN = len(content)
        return

    # 从第二个 chunk 开始检测
    if _DELTA_MODE is None:
        accumulated = "".join(pending_text)
        # 如果新内容以已有内容为前缀且更长 → 累积模式
        if content.startswith(accumulated) and len(content) > len(accumulated):
            _DELTA_MODE = "accumulated"
            emitter._log("[delta-detect] 检测到累积模式，改用 replace 而非 append", "debug")
        else:
            _DELTA_MODE = "delta"
            emitter._log("[delta-detect] 检测到增量模式，使用 append", "debug")

    if _DELTA_MODE == "accumulated":
        pending_text.clear()
        pending_text.append(content)
    else:
        pending_text.append(content)


def _clean_llm_content(content: str) -> str:
    """清理 LLM 输出中的 <unused*> 标签。"""
    cleaned = re.sub(r"<unused\d+>.*?</unused\d+>", "", content, flags=re.DOTALL)
    cleaned = re.sub(r"<unused\d+>", "", cleaned).strip()
    return cleaned


def _handle_stream_message(
    msg: Any,
    metadata: dict[str, Any],
    emitter: AgentEventEmitter,
    tool_call_registry: dict[str, dict[str, Any]],
    pending_text: list[str],
) -> None:
    """处理单个流式消息（AIMessage/AIMessageChunk/ToolMessage）。"""
    msg_type = type(msg).__name__

    if isinstance(msg, (AIMessage, AIMessageChunk)) or msg_type in ("AIMessage", "AIMessageChunk"):
        has_tool_calls = hasattr(msg, "tool_calls") and msg.tool_calls

        if has_tool_calls:
            narrated = bool(_flush_pending_text(emitter, pending_text))
            msg_content = str(msg.content) if hasattr(msg, "content") and msg.content else ""
            msg_content = _clean_llm_content(msg_content)
            if msg_content and not narrated:
                emitter.emit("agent_message", {"content": msg_content})
                narrated = True
            for tc in msg.tool_calls:
                tool_name = str(tc.get("name", "") or "").strip()
                tool_args = str(tc.get("args", "") or "")[:500]
                tool_call_id = str(tc.get("id", "") or "")

                if tool_name:
                    if not narrated:
                        emitter.emit("agent_message", {
                            "content": build_tool_action_message(tool_name, tool_args),
                            "kind": "progress",
                        })
                        narrated = True
                    emitter._log(f"调用工具: {tool_name}, 参数: {tool_args[:80]}", "info")
                    emitter.emit("agent_tool_call", {
                        "tool_name": tool_name,
                        "tool_input": tool_args,
                        "tool_result": "执行中...",
                        "elapsed_sec": 0,
                        "step": len(tool_call_registry) + 1,
                    })
                    tool_call_registry[tool_call_id] = {
                        "tool_name": tool_name,
                        "tool_input": tool_args,
                        "tool_result": "",
                        "tool_call_id": tool_call_id,
                    }
                else:
                    matched = None
                    if tool_call_id and tool_call_id in tool_call_registry:
                        matched = tool_call_registry[tool_call_id]
                    elif tool_call_registry:
                        matched = list(tool_call_registry.values())[-1]
                    if matched and tool_args:
                        existing = matched["tool_input"]
                        matched["tool_input"] = (existing + tool_args)[:500]
                        emitter._log(f"补充工具参数: {matched['tool_name']} += {tool_args[:80]}", "debug")
                    elif matched:
                        emitter._log(f"tool_call chunk (无 name 无 args): {tc}", "debug")
                    else:
                        emitter._log(f"跳过无法匹配的 tool_call chunk: {tc}", "debug")
        else:
            text_content = str(msg.content) if hasattr(msg, "content") and msg.content else ""
            reasoning_content = ""
            if hasattr(msg, "additional_kwargs"):
                reasoning_content = str(msg.additional_kwargs.get("reasoning_content", ""))
            if not text_content and reasoning_content:
                emitter.emit("agent_thinking_delta", {"content": reasoning_content})
                return
            if text_content:
                text_content = _clean_llm_content(text_content)
                if text_content:
                    _detect_and_append_delta(pending_text, text_content, emitter)

    elif isinstance(msg, ToolMessage) or msg_type == "ToolMessage":
        _flush_pending_text(emitter, pending_text)
        tool_name = str(getattr(msg, "name", ""))
        tool_result = str(msg.content) if hasattr(msg, "content") else str(msg)
        tool_call_id = str(getattr(msg, "tool_call_id", ""))

        tc = tool_call_registry.get(tool_call_id)
        if tc:
            tc["tool_result"] = tool_result[:1000]
            emitter._log(f"工具 {tool_name} 返回结果: {tool_result[:100]}", "debug")
            emitter.emit("agent_tool_call", {
                "tool_name": tool_name,
                "tool_input": tc["tool_input"],
                "tool_result": tool_result[:1000],
                "elapsed_sec": 0,
                "step": len(tool_call_registry),
            })
        else:
            emitter._log(f"工具结果（无匹配调用）: {tool_name} - {tool_result[:80]}", "debug")


def _is_recursion_error(exc: Exception) -> bool:
    """检测是否为 LangGraph 递归限制错误。"""
    msg = str(exc).lower()
    return any(kw in msg for kw in (
        "recursion limit",
        "recursion_limit",
        "graph recursion",
        "max iterations",
        "maximum number of agent steps",
    ))


def _generate_recursion_summary(
    emitter: AgentEventEmitter,
    _create_chat_model: Any,
    model_config: dict[str, Any],
    tool_call_registry: dict[str, dict[str, Any]],
    conversation_messages: list,
    error_msg: str,
) -> dict[str, Any]:
    """在递归限制触发后，让 LLM 总结已完成的工作和遇到的问题。"""
    try:
        tool_lines = []
        for i, (tc_id, info) in enumerate(tool_call_registry.items(), 1):
            tool_name = info.get("tool_name", "unknown")
            tool_input = str(info.get("tool_input", ""))[:200]
            tool_result = str(info.get("tool_result", ""))[:200]
            status = "完成" if tool_result else "执行中"
            tool_lines.append(f"  {i}. `{tool_name}` — 输入: {tool_input[:80]} — {status}")

        tool_summary_text = "\n".join(tool_lines) if tool_lines else "  （无工具调用记录）"

        summary_prompt = f"""你是 TriMusicAgent。之前的执行因达到最大迭代次数而中止。

已完成的工具调用：
{tool_summary_text}

错误信息：{error_msg}

请用中文向用户说明：
1. 已完成了哪些工作
2. 遇到了什么问题（为什么会达到迭代上限）
3. 建议用户下一步怎么做（例如：补充更明确的指令、拆分任务等）

请用简洁的 markdown 格式回复，不要调用任何工具。"""

        llm = _create_chat_model(model_config)
        response = llm.invoke(summary_prompt)
        message = str(response.content) if hasattr(response, "content") else str(response)

        emitter._log(f"递归限制总结生成完成: {message[:100]}", "info")
        return {"message": message}
    except Exception as e:
        emitter._log(f"递归总结生成失败: {e}", "error")
        tool_count = len(tool_call_registry)
        tool_names = [info.get("tool_name", "unknown") for info in tool_call_registry.values()]
        return {
            "message": (
                f"本次任务已完成 {tool_count} 个工具调用"
                f"（{', '.join(tool_names)}），"
                f"但因达到最大迭代次数未能全部完成。"
                f"建议你检查一下任务是否陷入循环，并给出更明确的指令。"
            )
        }


__all__ = [
    "_handle_stream_message",
    "_flush_pending_text",
    "_generate_recursion_summary",
    "_is_recursion_error",
    "_detect_and_append_delta",
    "_clean_llm_content",
    "reset_delta_mode",
]
