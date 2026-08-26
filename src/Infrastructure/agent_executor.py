from __future__ import annotations

import threading
import time
from typing import Any, Callable

from src.Infrastructure.agent_model import create_chat_model
from src.Infrastructure.agent_progress import (
    AgentEventEmitter,
    build_initial_action_message,
    build_system_prompt,
    build_tool_action_message,
)
from src.Infrastructure.agent_tools import ALL_TOOLS, TOOL_NAMES, TOOL_DESCRIPTIONS

try:
    from langchain.agents import create_agent
    from langchain.chat_models import init_chat_model
    from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

    _LANGCHAIN_AVAILABLE = True
except ImportError:
    _LANGCHAIN_AVAILABLE = False

    def create_agent(*args: Any, **kwargs: Any) -> Any:
        raise ImportError("langchain is not installed")

    def init_chat_model(*args: Any, **kwargs: Any) -> Any:
        raise ImportError("langchain is not installed")

    class HumanMessage:
        def __init__(self, content: str) -> None:
            self.content = content

    class AIMessage:
        def __init__(self, content: str) -> None:
            self.content = content


def _create_chat_model(model_config: dict[str, Any]):
    if not _LANGCHAIN_AVAILABLE:
        raise RuntimeError("langchain 未安装")
    return create_chat_model(model_config, init_chat_model)


def _build_tools_for_llm() -> list:
    return list(ALL_TOOLS)


def _flush_pending_text(
    emitter: AgentEventEmitter,
    pending_text: list[str],
) -> str:
    text = "".join(pending_text).strip()
    if text:
        emitter._log(f"Agent 回复: {text[:150]}", "info")
        emitter.emit("agent_message", {
            "content": text,
            "tool_calls_count": 0,
        })
    pending_text.clear()
    return text


def _handle_stream_message(
    msg: Any,
    metadata: dict[str, Any],
    emitter: AgentEventEmitter,
    tool_call_registry: dict[str, dict[str, Any]],
    pending_text: list[str],
) -> None:
    msg_type = type(msg).__name__

    if isinstance(msg, AIMessage) or msg_type == "AIMessage":
        has_tool_calls = hasattr(msg, "tool_calls") and msg.tool_calls

        if has_tool_calls:
            narrated = bool(_flush_pending_text(emitter, pending_text))
            for tc in msg.tool_calls:
                tool_name = tc.get("name", "unknown")
                tool_args = str(tc.get("args", ""))[:500]
                tool_call_id = tc.get("id", "")
                if not narrated:
                    emitter.emit("agent_message", {
                        "content": build_tool_action_message(tool_name),
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
            text_content = str(msg.content) if hasattr(msg, "content") and msg.content else ""
            if text_content:
                pending_text.append(text_content)

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
        agent = create_agent(llm, tools, system_prompt=system_prompt)
        emitter._log("Agent 已创建")

        emitter.emit("agent_ready", {"tools": TOOL_NAMES})

        emitter._log(f"开始调用 agent.stream()，用户消息: {user_message[:80]}...")
        emitter.emit("agent_step_started", {"step": 1})
        step_started = time.perf_counter()

        graph_config = {"recursion_limit": max(max_iterations * 4, 80)}
        emitter._log(f"设置递归限制: {graph_config['recursion_limit']} (max_iterations={max_iterations})", "debug")

        import concurrent.futures
        executor_timeout = 1800

        # 构建对话消息，包含历史上下文（如果有）
        conversation_messages: list = []
        if conversation_history:
            for msg in conversation_history:
                role = str(msg.get("role", ""))
                content = str(msg.get("content", ""))
                if role == "user":
                    conversation_messages.append(HumanMessage(content=content))
                elif role == "assistant":
                    conversation_messages.append(AIMessage(content=content))
            emitter._log(f"已加载 {len(conversation_history)} 条历史消息作为对话上下文", "info")

        conversation_messages.append(HumanMessage(content=user_message))
        emitter._log(f"当前共 {len(conversation_messages)} 条对话消息（含历史）", "debug")
        cancel_event = threading.Event()

        def _stream_once(messages: list) -> None:
            nonlocal last_ai_message, stream_error, event_count, actual_iterations, cancelled
            try:
                for item in agent.stream(
                    {"messages": messages},
                    config=graph_config,
                    stream_mode="messages",
                ):
                    # 检查取消信号
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
            # 清除取消信号（新一轮开始）
            cancel_event.clear()
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as thread_pool:
                future = thread_pool.submit(_stream_once, messages)
                try:
                    future.result(timeout=executor_timeout)
                except concurrent.futures.TimeoutError:
                    # 设置取消信号，让 _stream_once 线程尽快退出
                    cancel_event.set()
                    emitter._log(f"agent.stream() 超时 ({executor_timeout}s)，已发送取消信号", "error")
                    emitter.emit("agent_step_failed", {
                        "step": 1,
                        "error": f"执行超时 ({executor_timeout}s)，LLM 可能无响应",
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
            "step": 1,
            "elapsed_sec": elapsed,
            "tool_calls_count": len(tool_calls_made),
        })

        emitter._log(f"Agent 最终输出: {str(last_ai_message)[:200]}")
        emitter._log(f"Agent 执行完成，共调用 {len(tool_calls_made)} 个工具")

        status = "completed"
        emitter.emit("agent_finished", {
            "status": status,
            "tool_calls_count": len(tool_calls_made),
            "response_preview": str(last_ai_message)[:200] if last_ai_message else "",
            "elapsed_sec": elapsed,
        })

        return {
            "status": status,
            "response": str(last_ai_message),
            "tool_calls": tool_calls_made,
            "iterations": actual_iterations,
            "elapsed_sec": elapsed,
        }

    except Exception as exc:
        import traceback
        tb = traceback.format_exc()
        emitter._log(f"Agent 执行异常: {exc}\n{tb}", "error")
        completed_count = len(tool_call_registry)
        tool_summary = [info.get("tool_name", "unknown") for info in tool_call_registry.values()]
        emitter.emit("agent_error", {
            "error": str(exc),
            "completed_tool_calls": completed_count,
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
            "status": "failed",
            "error": str(exc),
            "completed_tool_calls": completed_count,
        })
        return {
            "status": "failed",
            "error": str(exc),
            "completed_tool_calls": completed_count,
            "tool_calls": list(tool_call_registry.values()),
        }


def check_langchain_available() -> bool:
    return _LANGCHAIN_AVAILABLE


def get_available_tools() -> list[dict[str, str]]:
    return [
        {"name": name, "description": TOOL_DESCRIPTIONS.get(name, "")}
        for name in TOOL_NAMES
    ]
