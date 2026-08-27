"""Agent message handler — 流式消息处理。

从 media/transcode/stream_handler.py 迁移而来，
原位置违反六边形架构（agent 适配器不应依赖 media 适配器）。

SRP 拆分：
- Delta 检测 → agent_delta_detector.py
- 递归总结 → agent_recursion_handler.py
"""
from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any, Union

from src.Infrastructure.adapters.agent.progress.agent_action_builder import (
    build_tool_action_message,
)
from src.Infrastructure.adapters.agent.progress.agent_delta_detector import (
    detect_and_append_delta,
    flush_pending_text,
    reset_delta_mode,
)
from src.Infrastructure.adapters.agent.progress.agent_recursion_handler import (
    generate_recursion_summary,
    is_recursion_error,
)

if TYPE_CHECKING:
    from src.Infrastructure.adapters.agent.progress.agent_progress import AgentEventEmitter

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


# 具体消息类型替代 msg: Any
AIMessageLike = Union[AIMessage, AIMessageChunk]
MessageLike = Union[AIMessage, AIMessageChunk, ToolMessage]
ToolCallInfo = dict[str, Any]
StreamMetadata = dict[str, Any]


def _clean_llm_content(content: str) -> str:
    """清理 LLM 输出中的 <unused*> 标签。"""
    cleaned = re.sub(r"<unused\d+>.*?</unused\d+>", "", content, flags=re.DOTALL)
    cleaned = re.sub(r"<unused\d+>", "", cleaned).strip()
    return cleaned


def handle_stream_message(
    msg: MessageLike,
    metadata: StreamMetadata,
    emitter: AgentEventEmitter,
    tool_call_registry: dict[str, ToolCallInfo],
    pending_text: list[str],
) -> None:
    """处理单个流式消息（AIMessage/AIMessageChunk/ToolMessage）。

    类型注解已修复：`msg` 使用联合类型而非 `Any`，
    `metadata` 使用 `StreamMetadata` 字典别名。
    """
    msg_type = type(msg).__name__

    if isinstance(msg, (AIMessage, AIMessageChunk)) or msg_type in ("AIMessage", "AIMessageChunk"):
        has_tool_calls = hasattr(msg, "tool_calls") and msg.tool_calls

        if has_tool_calls:
            narrated = bool(flush_pending_text(emitter, pending_text))
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
                    emitter._log(f"调用工具: {tool_name}, 参数: {tool_args[:80]}", "info")
                    # 只发射 agent_tool_call 卡片，不再发射冗余的 agent_message notice
                    emitter.emit("agent_tool_call", {
                        "tool_name": tool_name,
                        "tool_input": tool_args,
                        "tool_result": "执行中...",
                        "elapsed_sec": 0,
                        "step": len(tool_call_registry) + 1,
                        "action_text": build_tool_action_message(tool_name, tool_args),
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
                    detect_and_append_delta(pending_text, text_content, emitter)

    elif isinstance(msg, ToolMessage) or msg_type == "ToolMessage":
        flush_pending_text(emitter, pending_text)
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


# Backward-compatible aliases for external callers
_handle_stream_message = handle_stream_message
_flush_pending_text = flush_pending_text
_generate_recursion_summary = generate_recursion_summary
_is_recursion_error = is_recursion_error

__all__ = [
    "handle_stream_message",
    "flush_pending_text",
    "generate_recursion_summary",
    "is_recursion_error",
    "reset_delta_mode",
    "_clean_llm_content",
    "_handle_stream_message",
    "_flush_pending_text",
    "_generate_recursion_summary",
    "_is_recursion_error",
    "AIMessageLike",
    "MessageLike",
    "ToolCallInfo",
    "StreamMetadata",
]