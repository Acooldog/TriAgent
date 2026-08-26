from __future__ import annotations

import threading
import time
from typing import Any, Callable

from src.Infrastructure.adapters.agent.agent_helpers import (
    AIMessage,
    HumanMessage,
    LANGCHAIN_AVAILABLE as _LANGCHAIN_AVAILABLE,
    build_conversation_messages,
    build_tools_for_llm as _build_tools_for_llm,
    check_langchain_available,
    create_agent,
    create_chat_model_func as _create_chat_model,
    init_chat_model,
)
from src.Infrastructure.adapters.agent.agent_model import create_chat_model
from src.Infrastructure.adapters.agent.agent_progress import (
    AgentEventEmitter,
    build_initial_action_message,
    build_system_prompt,
)
from src.Infrastructure.adapters.agent.tools.agent_tools import TOOL_DESCRIPTIONS, TOOL_NAMES
from src.Infrastructure.adapters.media.transcode.stream_handler import (
    _flush_pending_text,
    _generate_recursion_summary,
    _handle_stream_message,
    _is_recursion_error,
)


def run_agent(
    user_message: str,
    model_config: dict[str, Any],
    event_sink: Callable[[str, dict[str, Any]], None],
    max_iterations: int = 15,
    stop_requested: Callable[[], bool] | None = None,
    announce_start: bool = True,
    consume_supplements: Callable[[], list[str]] | None = None,
    conversation_history: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    emitter = AgentEventEmitter(event_sink)
    emitter.emit("agent_started", {"message": user_message, "model": model_config.get("model", "")})
    if announce_start:
        emitter.emit("agent_message", {
            "content": build_initial_action_message(user_message),
            "kind": "progress",
        })

    if not _LANGCHAIN_AVAILABLE:
        emitter._log("langchain 不可用，返回失败", "error")
        emitter.emit("agent_error", {"error": "langchain 未安装"})
        emitter.emit("agent_finished", {"status": "failed", "reason": "langchain_not_installed"})
        return {"status": "failed", "reason": "langchain_not_installed"}

    tool_call_registry: dict[str, dict[str, Any]] = {}
    pending_text: list[str] = []
    last_ai_message = ""
    stream_error = None
    event_count = 0
    actual_iterations = 0
    cancelled = False
    timed_out = False

    try:
        emitter._log("正在创建聊天模型...")
        llm = _create_chat_model(model_config)
        emitter._log(f"聊天模型已创建: {model_config.get('model')}")

        emitter._log("正在构建工具列表...")
        tools = _build_tools_for_llm()
        emitter._log(f"已加载 {len(tools)} 个工具: {TOOL_NAMES}")

        system_prompt = build_system_prompt(TOOL_NAMES, TOOL_DESCRIPTIONS)
        emitter._log("正在创建 agent...")
        agent_inst = create_agent(llm, tools, system_prompt=system_prompt)
        emitter._log("Agent 已创建")

        emitter.emit("agent_ready", {"tools": TOOL_NAMES})
        emitter._log(f"开始调用 agent.stream()，用户消息: {user_message[:80]}...")
        emitter.emit("agent_step_started", {"step": 1})
        step_started = time.perf_counter()

        graph_config = {"recursion_limit": max(min(max_iterations * 4, 40), 20)}
        emitter._log(f"设置递归限制: {graph_config['recursion_limit']} (max_iterations={max_iterations})", "debug")

        import concurrent.futures
        executor_timeout = 1800

        conversation_messages = build_conversation_messages(conversation_history, user_message)
        emitter._log(f"当前共 {len(conversation_messages)} 条对话消息（含历史）", "debug")
        cancel_event = threading.Event()

        def _stream_once(messages: list) -> None:
            nonlocal last_ai_message, stream_error, event_count, actual_iterations, cancelled
            try:
                for item in agent_inst.stream(
                    {"messages": messages},
                    config=graph_config,
                    stream_mode="messages",
                ):
                    if cancel_event.is_set():
                        emitter._log("收到超时取消信号，终止流式处理...", "info")
                        cancelled = True
                        break
                    if stop_requested and stop_requested():
                        emitter._log("收到取消请求，停止流式处理...", "info")
                        cancelled = True
                        break
                    event_count += 1
                    if event_count % 50 == 0:
                        emitter._log(f"已处理 {event_count} 个流式事件...", "debug")
                    msg, metadata = item
                    _handle_stream_message(msg, metadata, emitter, tool_call_registry, pending_text)
                    conversation_messages.append(msg)
                    if isinstance(msg, AIMessage) or type(msg).__name__ == "AIMessage":
                        if hasattr(msg, "tool_calls") and msg.tool_calls:
                            actual_iterations += 1
                if not cancelled:
                    flushed = _flush_pending_text(emitter, pending_text)
                    if flushed:
                        last_ai_message = flushed
            except Exception as e:
                stream_error = e
                _flush_pending_text(emitter, pending_text)

        def _run_stream_with_timeout(messages: list) -> None:
            nonlocal cancelled, timed_out
            cancel_event.clear()
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as thread_pool:
                future = thread_pool.submit(_stream_once, messages)
                try:
                    future.result(timeout=executor_timeout)
                except concurrent.futures.TimeoutError:
                    cancel_event.set()
                    emitter._log(f"agent.stream() 超时 ({executor_timeout}s)，已发送取消信号", "error")
                    emitter.emit("agent_step_failed", {
                        "step": 1, "error": f"执行超时 ({executor_timeout}s)，LLM 可能无响应",
                        "elapsed_sec": round(time.perf_counter() - step_started, 3),
                    })
                    emitter.emit("agent_finished", {"status": "timeout", "error": "llm_timeout"})
                    timed_out = True
                    cancelled = True
                    return
                if stream_error is not None:
                    raise stream_error

        emitter._log("提交 agent.stream() 到线程池...", "debug")
        _run_stream_with_timeout(conversation_messages)

        supplement_round = 0
        while not cancelled and stream_error is None and consume_supplements is not None:
            new_supplements = consume_supplements()
            if not new_supplements:
                break
            supplement_round += 1
            emitter._log(f"处理第 {supplement_round} 轮用户补充：{len(new_supplements)} 条", "info")
            for s in new_supplements:
                conversation_messages.append(HumanMessage(content=s))
            emitter.emit("agent_step_started", {"step": supplement_round + 1, "message": "用户补充"})
            emitter.emit("agent_message", {
                "content": f"已收到用户补充（第 {supplement_round} 轮），正在据此继续完成任务。",
                "kind": "progress",
            })
            _run_stream_with_timeout(conversation_messages)

        if timed_out:
            return {"status": "timeout", "error": "llm_timeout"}
        if cancelled:
            elapsed = round(time.perf_counter() - step_started, 3)
            emitter._log(f"Agent 已取消，耗时 {elapsed}s", "info")
            emitter.emit("agent_finished", {"status": "cancelled"})
            return {"status": "cancelled", "elapsed_sec": elapsed}

        emitter._log("agent.stream() 完成")
        elapsed = round(time.perf_counter() - step_started, 3)
        emitter._log(f"执行耗时: {elapsed}s, 共处理 {event_count} 个事件")
        emitter._log(f"实际工具调用迭代: {actual_iterations}")

        tool_calls_made = list(tool_call_registry.values())
        emitter._log(f"共检测到 {len(tool_calls_made)} 个工具调用")
        emitter.emit("agent_step_finished", {
            "step": 1, "elapsed_sec": elapsed, "tool_calls_count": len(tool_calls_made),
        })
        emitter._log(f"Agent 最终输出: {str(last_ai_message)[:200]}")
        emitter._log(f"Agent 执行完成，共调用 {len(tool_calls_made)} 个工具")

        emitter.emit("agent_finished", {
            "status": "completed", "tool_calls_count": len(tool_calls_made),
            "response_preview": str(last_ai_message)[:200] if last_ai_message else "",
            "elapsed_sec": elapsed,
        })
        return {
            "status": "completed", "response": str(last_ai_message),
            "tool_calls": tool_calls_made, "iterations": actual_iterations,
            "elapsed_sec": elapsed,
        }

    except Exception as exc:
        import traceback
        tb = traceback.format_exc()
        completed_count = len(tool_call_registry)
        tool_summary = [info.get("tool_name", "unknown") for info in tool_call_registry.values()]

        if _is_recursion_error(exc):
            emitter._log(f"Agent 达到递归限制，转为总结模式: {exc}", "warning")
            summary_result = _generate_recursion_summary(
                emitter, create_chat_model, model_config, tool_call_registry,
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
            return {
                "status": "completed", "response": summary_result.get("message", ""),
                "tool_calls": list(tool_call_registry.values()), "iterations": actual_iterations,
                "elapsed_sec": round(time.perf_counter() - step_started, 3),
                "recursion_limit_hit": True,
            }

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
        return {
            "status": "failed", "error": str(exc),
            "completed_tool_calls": completed_count,
            "tool_calls": list(tool_call_registry.values()),
        }


def get_available_tools() -> list[dict[str, str]]:
    return [
        {"name": name, "description": TOOL_DESCRIPTIONS.get(name, "")}
        for name in TOOL_NAMES
    ]


# Re-export langchain helpers for callers that import from this module
__all__ = [
    "run_agent",
    "check_langchain_available",
    "get_available_tools",
    "create_agent",
    "init_chat_model",
    "HumanMessage",
    "AIMessage",
]
