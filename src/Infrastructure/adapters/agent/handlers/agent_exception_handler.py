"""Agent exception handler — Agent 执行异常处理。

从 agent_executor.py 拆出，负责：
- 递归限制异常的总结模式
- 普通异常的错误报告
"""
from __future__ import annotations

import time
import traceback
from typing import Any, Callable


class AgentExceptionResult:
    """异常处理结果。"""
    def __init__(self, data: dict[str, Any]):
        self.data = data

    @property
    def status(self) -> str:
        return self.data.get("status", "failed")

    @property
    def is_recursion_limit_hit(self) -> bool:
        return self.data.get("recursion_limit_hit", False)


def handle_agent_exception(
    exc: Exception,
    emitter: Any,
    model_config: dict[str, Any],
    tool_call_registry: dict[str, dict[str, Any]],
    conversation_messages: list,
    step_started: float,
    actual_iterations: int,
    create_chat_model_fn: Callable,
    is_recursion_error_fn: Callable,
    generate_recursion_summary_fn: Callable,
) -> AgentExceptionResult:
    """处理 Agent 执行异常。返回 AgentExceptionResult。"""
    tb = traceback.format_exc()
    completed_count = len(tool_call_registry)
    tool_summary = [info.get("tool_name", "unknown") for info in tool_call_registry.values()]

    if is_recursion_error_fn(exc):
        emitter._log(f"Agent 达到递归限制，转为总结模式: {exc}", "warning")
        summary_result = generate_recursion_summary_fn(
            emitter, create_chat_model_fn, model_config, tool_call_registry,
            conversation_messages, str(exc),
        )
        emitter.emit("agent_message", {
            "content": summary_result.get("message", ""), "kind": "progress",
        })
        emitter.emit("agent_finished", {
            "status": "completed", "tool_calls_count": completed_count,
            "response_preview": summary_result.get("message", "")[:200],
            "elapsed_sec": round(time.perf_counter() - step_started, 3),
        })
        return AgentExceptionResult({
            "status": "completed", "response": summary_result.get("message", ""),
            "tool_calls": list(tool_call_registry.values()), "iterations": actual_iterations,
            "elapsed_sec": round(time.perf_counter() - step_started, 3),
            "recursion_limit_hit": True,
        })

    emitter._log(f"Agent 执行异常: {exc}\n{tb}", "error")
    emitter.emit("agent_error", {
        "error": str(exc), "completed_tool_calls": completed_count,
        "tool_calls_summary": tool_summary,
    })
    emitter.emit("agent_message", {
        "content": (
            f"执行中断：已完成 {completed_count} 个工具调用"
            f"（{', '.join(tool_summary) if tool_summary else '无'}）后因异常中止：{exc}。"
            "已处理的文件已记录在 _processed_index.json，重新发起任务时会自动跳过，继续未完成的部分。"
        ),
        "kind": "error",
    })
    emitter.emit("agent_finished", {
        "status": "failed", "error": str(exc), "completed_tool_calls": completed_count,
    })
    return AgentExceptionResult({
        "status": "failed", "error": str(exc),
        "completed_tool_calls": completed_count,
        "tool_calls": list(tool_call_registry.values()),
    })


__all__ = [
    "AgentExceptionResult",
    "handle_agent_exception",
]
