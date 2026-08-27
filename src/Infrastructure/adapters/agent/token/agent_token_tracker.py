"""Agent token tracker — 对话历史 token 估算和分类统计。

从 agent_executor.py 拆出，提供会话消息的精确 token 估算。
区分中英文字符权重：中文 ≈ 1.5 tokens/char，英文 ≈ 0.25 tokens/char。
"""
from __future__ import annotations

from src.Infrastructure.adapters.agent.agent_helpers import estimate_messages_tokens


def estimate_tokens(messages: list) -> tuple[int, int]:
    """精确估算 conversation_messages 的字符数和 token 数（区分中英）。

    Returns:
        (total_chars, estimated_tokens)
    """
    return estimate_messages_tokens(messages)


def classify_messages(messages: list) -> str:
    """按消息类型分类统计，方便看哪种消息占空间。"""
    counts: dict[str, int] = {}
    for m in messages:
        t = type(m).__name__
        c = getattr(m, "content", "") or ""
        counts[t] = counts.get(t, 0) + len(str(c))
    parts = [f"{k}:{v}ch" for k, v in counts.items()]
    return " ".join(parts)


__all__ = [
    "estimate_tokens",
    "classify_messages",
]
