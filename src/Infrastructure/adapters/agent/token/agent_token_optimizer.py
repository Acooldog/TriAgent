"""Agent token optimizer — ToolMessage 截断、旧轮次裁剪、AIMessage 裁剪。

从 agent_executor.py 拆出，负责 LangGraph 对话历史的 token 节流优化：
- 截断过长的 ToolMessage content
- 裁剪旧轮次 ToolMessage 为摘要
- 裁剪旧轮次 AIMessage 为摘要
"""
from __future__ import annotations

from typing import Any

from src.Infrastructure.adapters.agent.agent_helpers import (
    AIMessage,
    ToolMessage,
    prune_old_ai_messages,
)


def truncate_tool_message(msg: Any, max_chars: int = 300, keep_head: int = 200) -> int:
    """直接修改 ToolMessage.content —— 超过 max_chars 就截断。返回节省的字符数。"""
    content = getattr(msg, "content", None)
    if content is None:
        return 0
    text = str(content)
    if len(text) <= max_chars:
        return 0
    original_len = len(text)
    truncated = text[:keep_head].rstrip() + f"...(已截断，原始 {original_len} 字符)"
    saved = original_len - len(truncated)
    try:
        msg.content = truncated
    except Exception:
        pass
    return saved


def prune_old_tool_results(messages: list, keep_last_rounds: int = 3) -> int:
    """清理 conversation_messages 中的旧 ToolMessage。返回节省的字符数。"""
    tool_round_indices: list[int] = []
    for i, m in enumerate(messages):
        if isinstance(m, AIMessage) or type(m).__name__ == "AIMessage":
            tool_calls = getattr(m, "tool_calls", None)
            if tool_calls:
                tool_round_indices.append(i)

    if len(tool_round_indices) <= keep_last_rounds:
        return 0

    rounds_to_keep = tool_round_indices[-keep_last_rounds:]
    keep_from = rounds_to_keep[0]

    total_saved = 0
    for i in range(keep_from):
        m = messages[i]
        if isinstance(m, ToolMessage) or type(m).__name__ == "ToolMessage":
            orig_text = str(getattr(m, "content", ""))
            if "(已截断" in orig_text:
                continue
            name = getattr(m, "name", "tool")
            summary = f"[{name} 结果已省略 — 属于前序轮次]"
            saved = len(orig_text) - len(summary)
            if saved > 0:
                total_saved += saved
            try:
                m.content = summary
            except Exception:
                pass
    return total_saved


def prune_old_ai_rounds(messages: list, keep_last_rounds: int = 4) -> int:
    """裁剪旧轮次 AIMessage 为摘要。返回节省的字符数。

    代理到 agent_helpers.prune_old_ai_messages，保持统一接口。
    """
    return prune_old_ai_messages(messages, keep_last_rounds=keep_last_rounds)


__all__ = [
    "truncate_tool_message",
    "prune_old_tool_results",
    "prune_old_ai_rounds",
]
