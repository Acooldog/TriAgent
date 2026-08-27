"""Agent executor — Agent 执行编排器。

负责串联：配置清理 → LLM预检 → Agent创建 → 流式执行 → 补充处理 → 结果汇总。

注：嵌套闭包 _stream_once / _run_stream_with_timeout 保留在此文件中，
因为它们共享 10+ 个 nonlocal 变量，提取风险较高。
Token 优化逻辑已拆至 agent_token_optimizer.py / agent_token_tracker.py。
配置预检已拆至 agent_config_preflight.py。
"""
from __future__ import annotations

import concurrent.futures
import threading
import time
from typing import Any, Callable

from src.Infrastructure.adapters.agent.agent_helpers import (
    AIMessage,
    AIMessageChunk,
    HumanMessage,
    LANGCHAIN_AVAILABLE as _LANGCHAIN_AVAILABLE,
    ToolMessage,
    build_conversation_messages,
    build_tools_for_llm as _build_tools_for_llm,
    check_langchain_available,
    create_agent,
    create_chat_model_func as _create_chat_model,
    init_chat_model,
)
from src.Infrastructure.adapters.agent.agent_model import create_chat_model
from src.Infrastructure.adapters.agent.progress.agent_progress import (
    AgentEventEmitter,
    build_initial_action_message,
    build_system_prompt,
)
from src.Infrastructure.adapters.agent.progress.agent_stream_processor import (
    log_progress_snapshot,
    prune_tool_results_after_tool_call,
    process_tool_message_truncation,
    update_thinking_state,
)
from src.Infrastructure.adapters.agent.token.agent_token_optimizer import (
    prune_old_tool_results as _prune_old_tool_results,
    truncate_tool_message as _truncate_tool_message,
)
from src.Infrastructure.adapters.agent.token.agent_token_tracker import (
    classify_messages as _classify_msgs,
    estimate_tokens as _estimate_tokens,
)
from src.Infrastructure.adapters.agent.config.agent_config_preflight import (
    check_llm_connectivity,
    clean_model_config,
)
from src.Infrastructure.adapters.agent.tools.agent_tools import TOOL_DESCRIPTIONS, TOOL_NAMES
from src.Infrastructure.adapters.media.transcode.stream_handler import (
    _flush_pending_text,
    _generate_recursion_summary,
    _handle_stream_message,
    _is_recursion_error,
)
from src.Infrastructure.adapters.agent.tools.agent_tools_state import set_event_sink


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

    # 发送初始行动说明，让用户知道 Agent 即将执行的步骤
    initial_msg = build_initial_action_message(user_message)
    emitter.emit("agent_message", {"content": initial_msg, "kind": "progress"})

    # 注入事件发射回调，让解密/转码工具能发 batch_* 进度事件
    set_event_sink(event_sink)

    # === 统一清理 model_config 所有字段 ===
    clean_model_config(model_config, emitter._log)

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

        # 轻量预检：只检查 base_url 可达 + api_key 非空（不烧 token）
        emitter._log("正在检查模型配置...")
        preflight = check_llm_connectivity(model_config, emitter._log)
        if not preflight.ok:
            emitter._log(f"LLM 预检失败: {preflight.error}", "error")
            emitter.emit("agent_step_failed", {"step": 1, "error": preflight.error})
            emitter.emit("agent_finished", {"status": "error", "error": preflight.error})
            return {"status": "error", "error": preflight.error}

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

        graph_config = {"recursion_limit": max(min(max_iterations * 4, 200), 40)}
        emitter._log(f"设置递归限制: {graph_config['recursion_limit']} (max_iterations={max_iterations})", "debug")

        executor_timeout = 1800

        conversation_messages = build_conversation_messages(conversation_history, user_message)
        emitter._log(f"当前共 {len(conversation_messages)} 条对话消息（含历史）", "debug")
        cancel_event = threading.Event()

        # === token 估算日志 ===
        _total_estimated_input_tokens = 0  # 累计发给 LLM 的输入 token（估算）
        _total_truncate_saved = 0          # 截断工具输出省的字符
        _total_prune_saved = 0             # 裁剪旧轮次省的字符

        def _stream_once(messages: list) -> None:
            nonlocal last_ai_message, stream_error, event_count, actual_iterations, cancelled
            nonlocal _total_estimated_input_tokens, _total_truncate_saved, _total_prune_saved
            _thinking_count = 0  # 本轮深度思考块计数
            try:
                # === stream 前：估算本轮 LLM 输入 token ===
                _ch, _tk = _estimate_tokens(messages)
                _total_estimated_input_tokens += _tk
                emitter._log(
                    f"[token#{actual_iterations + 1}] 本轮输入 ≈ {_tk} tokens "
                    f"({_ch} 字符) — {_classify_msgs(messages)}",
                    "info",
                )
                emitter._log(f"[token#{actual_iterations + 1}] 累计输入 ≈ {_total_estimated_input_tokens} tokens", "debug")

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
                    msg, metadata = item
                    _handle_stream_message(msg, metadata, emitter, tool_call_registry, pending_text)

                    # === 深度思考检测与进度上报 ===
                    _thinking_count = update_thinking_state(msg, emitter, _thinking_count)

                    if event_count % 20 == 0:
                        _flush_pending_text(emitter, pending_text)
                    log_progress_snapshot(event_count, msg, pending_text, emitter)

                    # === ToolMessage content 截断 ===
                    _total_truncate_saved = process_tool_message_truncation(
                        msg, emitter, _total_truncate_saved,
                    )

                    conversation_messages.append(msg)

                    # === 每轮 AIMessage 触发工具调用后裁剪旧轮次 ===
                    actual_iterations, _total_prune_saved = prune_tool_results_after_tool_call(
                        msg, conversation_messages, emitter, actual_iterations, _total_prune_saved,
                    )
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

        from src.Infrastructure.adapters.agent.handlers.agent_result_reporter import (
            handle_timeout_or_cancelled,
            report_success_and_return,
        )
        early_result = handle_timeout_or_cancelled(timed_out, cancelled, emitter, step_started)
        if early_result is not None:
            return early_result

        return report_success_and_return(
            emitter=emitter,
            step_started=step_started,
            event_count=event_count,
            actual_iterations=actual_iterations,
            tool_call_registry=tool_call_registry,
            last_ai_message=last_ai_message,
            total_estimated_input_tokens=_total_estimated_input_tokens,
            total_truncate_saved=_total_truncate_saved,
            total_prune_saved=_total_prune_saved,
        )

    except Exception as exc:
        from src.Infrastructure.adapters.agent.handlers.agent_exception_handler import handle_agent_exception
        result = handle_agent_exception(
            exc=exc,
            emitter=emitter,
            model_config=model_config,
            tool_call_registry=tool_call_registry,
            conversation_messages=conversation_messages,
            step_started=step_started,
            actual_iterations=actual_iterations,
            create_chat_model_fn=create_chat_model,
            is_recursion_error_fn=_is_recursion_error,
            generate_recursion_summary_fn=_generate_recursion_summary,
        )
        return result.data


def get_available_tools() -> list[dict[str, str]]:
    return [
        {"name": name, "description": TOOL_DESCRIPTIONS.get(name, "")}
        for name in TOOL_NAMES
    ]


# Re-export langchain helpers for callers that import from this module
# Also re-export token optimizer functions for backward compatibility
__all__ = [
    "run_agent",
    "check_langchain_available",
    "get_available_tools",
    "create_agent",
    "init_chat_model",
    "HumanMessage",
    "AIMessage",
    # Re-exported for backward compat (sub_agent.py imports these)
    "_create_chat_model",
    "_handle_stream_message",
    "_truncate_tool_message",
    "_prune_old_tool_results",
    "ToolMessage",
]
