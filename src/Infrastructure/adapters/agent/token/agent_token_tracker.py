"""Agent token tracker — 对话历史 token 估算和分类统计。

从 agent_executor.py 拆出，提供会话消息的粗略 token 估算。
1 token ≈ 3.5 字符（中英混合场景）。
"""
from __future__ import annotations


def estimate_tokens(messages: list) -> tuple[int, int]:
    """粗估 conversation_messages 的字符数和 token 数。

    Returns:
        (total_chars, estimated_tokens)
    """
    total_chars = 0
    for m in messages:
        c = getattr(m, "content", "") or ""
        if isinstance(c, list):
            c = str(c)
        total_chars += len(str(c))
    return total_chars, int(total_chars / 3.5)


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
