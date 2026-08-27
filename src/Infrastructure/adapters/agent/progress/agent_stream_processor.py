"""Agent stream processor — 流式消息处理辅助函数。

从 agent_executor.py 拆出，提供：
- 深度思考检测与进度上报
- 定期进度日志
- ToolMessage 截断 + 旧轮次裁剪
- AIMessage 裁剪 + Token 预算检查
"""
from __future__ import annotations

from typing import Any

from src.Infrastructure.adapters.agent.agent_helpers import (
    AIMessage,
    AIMessageChunk,
    ToolMessage,
    estimate_messages_tokens,
)
from src.Infrastructure.adapters.agent.token.agent_token_optimizer import (
    prune_old_ai_rounds,
    prune_old_tool_results,
    truncate_tool_message,
)


def update_thinking_state(
    msg: Any,
    emitter: Any,
    thinking_count: int,
    deep_thinking: bool = True,
) -> int:
    """检测深度思考状态并定期上报进度。返回更新后的 thinking_count。"""
    content_now = str(getattr(msg, "content", "")) if hasattr(msg, "content") else ""
    tc_now = bool(getattr(msg, "tool_calls", None)) and len(getattr(msg, "tool_calls", None) or []) > 0
    is_ai = isinstance(msg, (AIMessage, AIMessageChunk)) or type(msg).__name__ in ("AIMessage", "AIMessageChunk")

    if is_ai:
        if not content_now and not tc_now:
            if not deep_thinking:
                return thinking_count
            thinking_count += 1
            if thinking_count > 0 and thinking_count % 30 == 0:
                emitter._log(
                    f"模型正在深度思考... (已收到 {thinking_count} 个思考块)",
                    "info",
                )
                emitter.emit("agent_thinking_delta", {
                    "content": f"⏳ 模型正在深度思考... ({thinking_count} chunks)",
                })
        else:
            if thinking_count > 0:
                emitter._log(f"思考结束，开始输出内容/工具调用（思考了 {thinking_count} 块）", "info")
                thinking_count = 0
    return thinking_count


def log_progress_snapshot(event_count: int, msg: Any, pending_text: list[str], emitter: Any) -> None:
    """每 50 个事件打印一次进度日志。"""
    if event_count % 50 == 0:
        mt = type(msg).__name__
        mc = str(getattr(msg, "content", ""))[:30] if hasattr(msg, "content") else ""
        has_tc = bool(getattr(msg, "tool_calls", None)) and len(getattr(msg, "tool_calls", None) or []) > 0
        pt_len = sum(len(p) for p in pending_text)
        emitter._log(
            f"已处理 {event_count} 事件 | 最新={mt}(content={mc!r}, tool_calls={has_tc}) | pending_text={pt_len}字符",
            "debug",
        )


def process_tool_message_truncation(
    msg: Any,
    emitter: Any,
    total_truncate_saved: int,
) -> int:
    """截断 ToolMessage content。返回更新后的 total_truncate_saved。"""
    if isinstance(msg, ToolMessage) or type(msg).__name__ == "ToolMessage":
        tool_name = getattr(msg, "name", "tool")
        if tool_name in ("scan_files", "list_directory", "rag_retrieve"):
            trunc_saved = truncate_tool_message(msg, max_chars=1200, keep_head=1000)
        else:
            trunc_saved = truncate_tool_message(msg, max_chars=300, keep_head=200)
        if trunc_saved > 0:
            total_truncate_saved += trunc_saved
            emitter._log(
                f"[token] 截断 ToolMessage({tool_name}) 节省 {trunc_saved} 字符 ≈ {int(trunc_saved/3.5)} tokens",
                "info",
            )
    return total_truncate_saved


def prune_tool_results_after_tool_call(
    msg: Any,
    conversation_messages: list,
    emitter: Any,
    actual_iterations: int,
    total_prune_saved: int,
) -> tuple[int, int]:
    """每轮 AIMessage（触发工具调用）后裁剪旧 ToolMessage + AIMessage。返回 (actual_iterations, total_prune_saved)。"""
    is_ai = isinstance(msg, (AIMessage, AIMessageChunk)) or type(msg).__name__ in ("AIMessage", "AIMessageChunk")
    if is_ai and hasattr(msg, "tool_calls") and msg.tool_calls:
        actual_iterations += 1

        # 裁剪旧 ToolMessage
        pr_saved = prune_old_tool_results(conversation_messages, keep_last_rounds=3)
        if pr_saved > 0:
            total_prune_saved += pr_saved
            emitter._log(
                f"[token] 裁剪旧 ToolMessage 节省 {pr_saved} 字符 ≈ {int(pr_saved/3.5)} tokens",
                "info",
            )

        # 裁剪旧 AIMessage
        ai_saved = prune_old_ai_rounds(conversation_messages, keep_last_rounds=4)
        if ai_saved > 0:
            total_prune_saved += ai_saved
            emitter._log(
                f"[token] 裁剪旧 AIMessage 节省 {ai_saved} 字符 ≈ {int(ai_saved/3.5)} tokens",
                "info",
            )

    return actual_iterations, total_prune_saved


def check_token_budget(
    messages: list,
    max_input_tokens: int,
    emitter: Any,
) -> bool:
    """检查当前对话是否超出 token 预算。超出时自动压缩。

    Returns:
        True 表示预算充足可继续，False 表示已超限需压缩。
    """
    _chars, _tk = estimate_messages_tokens(messages)
    if _tk > max_input_tokens * 0.9:
        emitter._log(
            f"[token] 警告：当前输入 ≈ {_tk} tokens 接近预算上限 {max_input_tokens}，触发压缩...",
            "warning",
        )
        # 主动压缩：裁剪更多轮次
        ai_saved = prune_old_ai_rounds(messages, keep_last_rounds=4)
        tool_saved = prune_old_tool_results(messages, keep_last_rounds=2)
        total_saved = ai_saved + tool_saved
        if total_saved > 0:
            emitter._log(
                f"[token] 紧急压缩节省 {total_saved} 字符 ≈ {int(total_saved/3.5)} tokens",
                "info",
            )
        _chars2, _tk2 = estimate_messages_tokens(messages)
        return _tk2 <= max_input_tokens
    return True


__all__ = [
    "update_thinking_state",
    "log_progress_snapshot",
    "process_tool_message_truncation",
    "prune_tool_results_after_tool_call",
    "check_token_budget",
]
