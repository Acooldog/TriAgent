"""Agent result reporter — Agent 执行结果处理与上报。

从 agent_executor.py 拆出，负责：
- 超时/取消的提前返回
- 成功结果的日志和事件上报
- Token 消耗汇总
"""
from __future__ import annotations

import time
from typing import Any


def handle_timeout_or_cancelled(
    timed_out: bool,
    cancelled: bool,
    emitter: Any,
    step_started: float,
) -> dict[str, Any] | None:
    """处理超时或取消状态。返回结果字典或 None（表示继续正常流程）。"""
    if timed_out:
        return {"status": "timeout", "error": "llm_timeout"}
    if cancelled:
        elapsed = round(time.perf_counter() - step_started, 3)
        emitter._log(f"Agent 已取消，耗时 {elapsed}s", "info")
        emitter.emit("agent_finished", {"status": "cancelled"})
        return {"status": "cancelled", "elapsed_sec": elapsed}
    return None


def report_success_and_return(
    emitter: Any,
    step_started: float,
    event_count: int,
    actual_iterations: int,
    tool_call_registry: dict,
    last_ai_message: str,
    total_estimated_input_tokens: int,
    total_truncate_saved: int,
    total_prune_saved: int,
) -> dict[str, Any]:
    """上报成功结果并返回最终状态字典。"""
    emitter._log("agent.stream() 完成")
    elapsed = round(time.perf_counter() - step_started, 3)
    emitter._log(f"执行耗时: {elapsed}s, 共处理 {event_count} 个事件")
    emitter._log(f"实际工具调用迭代: {actual_iterations}")

    tool_calls_made = list(tool_call_registry.values())
    emitter._log(f"共检测到 {len(tool_calls_made)} 个工具调用")
    emitter.emit("agent_step_finished", {
        "step": 1, "elapsed_sec": elapsed, "tool_calls_count": len(tool_calls_made),
    })

    # === 完整输出日志 ===
    full_output = str(last_ai_message)
    emitter._log(f"Agent 最终输出（完整 {len(full_output)} 字符）: {full_output}", "info")

    emitter._log(f"Agent 最终输出预览: {full_output[:200]}")
    emitter._log(f"Agent 执行完成，共调用 {len(tool_calls_made)} 个工具")

    # === token 消耗汇总 ===
    total_saved_chars = total_truncate_saved + total_prune_saved
    total_saved_tokens = int(total_saved_chars / 3.5)
    emitter._log(
        f"[token 汇总] 累计输入 ≈ {total_estimated_input_tokens} tokens | "
        f"截断节省 ≈ {int(total_truncate_saved/3.5)} tokens | "
        f"裁剪节省 ≈ {int(total_prune_saved/3.5)} tokens | "
        f"**节流总计 ≈ {total_saved_tokens} tokens**（相当于 {total_saved_tokens/1000:.1f}K）",
        "info",
    )

    emitter.emit("agent_finished", {
        "status": "completed", "tool_calls_count": len(tool_calls_made),
        "response_preview": full_output[:200] if full_output else "",
        "elapsed_sec": elapsed,
    })
    return {
        "status": "completed", "response": full_output,
        "tool_calls": tool_calls_made, "iterations": actual_iterations,
        "elapsed_sec": elapsed,
    }


__all__ = [
    "handle_timeout_or_cancelled",
    "report_success_and_return",
]
