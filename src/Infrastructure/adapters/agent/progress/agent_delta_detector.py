"""agent_delta_detector — AIMessageChunk delta 模式检测。

从 agent_message_handler.py 拆分而来，负责：
- 检测 AIMessageChunk 是累积模式还是增量模式
- 追加到 pending_text 列表
"""
from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from src.Infrastructure.adapters.agent.progress.agent_progress import AgentEventEmitter

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


def flush_pending_text(
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


def detect_and_append_delta(
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


__all__ = [
    "reset_delta_mode",
    "flush_pending_text",
    "detect_and_append_delta",
]