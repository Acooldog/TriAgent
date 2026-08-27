"""Agent executor — Agent 执行编排器。

负责：配置清理 → LLM预检 → Agent创建 → 流式执行 → 补充处理 → 结果汇总。
嵌套闭包 _stream_once / _run_stream_with_timeout 保留在此文件中，
因为它们共享 10+ nonlocal 变量，提取风险较高。
"""
from __future__ import annotations

import concurrent.futures
import threading
import time
from typing import Any, Callable

from src.Infrastructure.adapters.agent.agent_helpers import (
    AIMessage, AIMessageChunk, HumanMessage, ToolMessage,
    LANGCHAIN_AVAILABLE as _LANGCHAIN_AVAILABLE,
    build_conversation_messages,
    build_tools_for_llm as _build_tools_for_llm,
    check_langchain_available,
    create_agent,
    create_chat_model_func as _create_chat_model,
    init_chat_model,
)
from src.Infrastructure.adapters.agent.config.agent_model import create_chat_model
from src.Infrastructure.adapters.agent.progress.agent_progress import (
    AgentEventEmitter,
    build_fallback_system_prompt,
    build_initial_action_message,
    build_system_prompt,
    detect_intent,
)
from src.Infrastructure.adapters.agent.progress.agent_stream_processor import (
    check_token_budget, log_progress_snapshot,
    prune_tool_results_after_tool_call,
    process_tool_message_truncation,
    update_thinking_state,
)
from src.Infrastructure.adapters.agent.progress.agent_message_handler import (
    _flush_pending_text, _generate_recursion_summary,
    _handle_stream_message, _is_recursion_error,
    reset_delta_mode,
)
from src.Infrastructure.adapters.agent.model_adapters import (
    ModelAdapterContext, select_adapter,
)
from src.Infrastructure.adapters.agent.config.agent_config_preflight import (
    check_llm_connectivity, clean_model_config,
)
from src.Infrastructure.adapters.agent.tools.agent_tools import TOOL_DESCRIPTIONS, TOOL_NAMES
from src.Infrastructure.adapters.agent.tools.agent_tools_state import set_event_sink, _safe_tool_name
from src.Infrastructure.adapters.agent.token.agent_token_tracker import (
    classify_messages as _classify_msgs,
    estimate_tokens as _estimate_tokens,
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
    deep_thinking: bool = True,
) -> dict[str, Any]:
    emitter = AgentEventEmitter(event_sink)
    emitter.emit("agent_started", {"message": user_message, "model": model_config.get("model", "")})
    initial_msg = build_initial_action_message(user_message)
    emitter.emit("agent_message", {"content": initial_msg, "kind": "progress"})
    set_event_sink(event_sink)
    clean_model_config(model_config, emitter._log)

    if not _LANGCHAIN_AVAILABLE:
        emitter._log("langchain 不可用，返回失败", "error")
        emitter.emit("agent_finished", {"status": "failed", "reason": "langchain_not_installed"})
        return {"status": "failed", "reason": "langchain_not_installed"}

    tool_call_registry: dict = {}
    pending_text: list[str] = []
    last_ai_message = ""
    stream_error = None
    event_count = actual_iterations = 0
    cancelled = timed_out = False

    try:
        emitter._log("正在创建聊天模型...")
        llm = _create_chat_model(model_config)
        emitter._log(f"聊天模型已创建: {model_config.get('model')}")

        # 轻量预检：只检查 base_url 可达 + api_key 非空（不烧 token）
        emitter._log("正在检查模型配置...")
        preflight = check_llm_connectivity(model_config, emitter._log)
        if not preflight.ok:
            emitter._log(f"LLM 预检失败: {preflight.error}", "error")
            emitter.emit("agent_finished", {"status": "error", "error": preflight.error})
            return {"status": "error", "error": preflight.error}

        # === 意图检测：选择 system prompt + 工具子集 ===
        detected_intent = detect_intent(user_message)
        emitter._log(f"意图检测结果: {detected_intent}")

        if detected_intent == "simple":
            from src.Infrastructure.adapters.agent.progress.agent_progress import _select_tools_for_simple
            tool_subset = _select_tools_for_simple(TOOL_NAMES)
            tools = [t for t in _build_tools_for_llm() if _safe_tool_name(t) in tool_subset]
            emitter._log(f"简单模式：{len(tools)} 个工具（子集）")
        elif detected_intent == "chat":
            tools = []
            emitter._log("聊天模式：不传工具")
        else:
            tools = _build_tools_for_llm()
            emitter._log(f"全量模式：{len(tools)} 个工具")

        system_prompt = build_system_prompt(TOOL_NAMES, TOOL_DESCRIPTIONS, intent=detected_intent)
        _max_input_tokens = int(model_config.get("max_tokens", 4096) or 4096) * 2
        _using_light_prompt = detected_intent in ("chat", "simple")
        _fallback_triggered = False
        _current_tools = tools

        emitter._log("正在创建 agent...")
        agent_inst = create_agent(llm, _current_tools, system_prompt=system_prompt)
        emitter._log(f"Agent 已创建 (prompt={detected_intent})")
        emitter.emit("agent_ready", {"tools": TOOL_NAMES})
        emitter._log(f"开始调用 agent.stream()，用户消息: {user_message[:80]}...")
        emitter.emit("agent_step_started", {"step": 1})
        step_started = time.perf_counter()

        graph_config = {"recursion_limit": max(min(max_iterations * 4, 200), 40)}
        executor_timeout = 1800
        conversation_messages = build_conversation_messages(conversation_history, user_message)
        cancel_event = threading.Event()
        _total_estimated_input_tokens = 0
        _total_truncate_saved = 0
        _total_prune_saved = 0

        def _stream_once(messages: list) -> None:
            nonlocal last_ai_message, stream_error, event_count, actual_iterations, cancelled
            nonlocal _total_estimated_input_tokens, _total_truncate_saved, _total_prune_saved
            nonlocal _using_light_prompt, _fallback_triggered, _current_tools, agent_inst, system_prompt
            _thinking_count = 0
            reset_delta_mode()
            try:
                _ch, _tk = _estimate_tokens(messages)
                _total_estimated_input_tokens += _tk
                emitter._log(f"[token#{actual_iterations + 1}] ≈ {_tk} tokens ({_ch}ch) — {_classify_msgs(messages)}", "info")

                if actual_iterations >= 2 and not check_token_budget(messages, _max_input_tokens, emitter):
                    emitter._log("Token 预算超限，紧急压缩...", "warning")

                _stream_start = time.perf_counter()
                emitter._log(f"开始 agent.stream() — 等待首个模型输出...", "info")
                for item in agent_inst.stream({"messages": messages}, config=graph_config, stream_mode="messages"):
                    if cancel_event.is_set():
                        cancelled = True
                        break
                    if stop_requested and stop_requested():
                        cancelled = True
                        break
                    event_count += 1
                    msg, metadata = item

                    # 首个 chunk 到达计时
                    if event_count == 1:
                        _first_chunk_elapsed = round(time.perf_counter() - _stream_start, 3)
                        emitter._log(f"首个模型输出到达 (+{_first_chunk_elapsed}s)", "info")

                    # 过滤 reasoning_content
                    if hasattr(msg, "additional_kwargs"):
                        msg.additional_kwargs.pop("reasoning_content", None)

                    # 记录模型原始输出（截断前）
                    is_ai = isinstance(msg, (AIMessage, AIMessageChunk)) or type(msg).__name__ in ("AIMessage", "AIMessageChunk")
                    if is_ai:
                        raw_content = str(getattr(msg, "content", "")) if hasattr(msg, "content") else ""
                        raw_tc = list(getattr(msg, "tool_calls", []) or [])
                        if raw_content or raw_tc:
                            emitter._log(
                                f"[模型输出#{event_count}] content={raw_content[:200]!r} tool_calls={[tc.get('name','?') for tc in raw_tc]}",
                                "debug",
                            )

                    _handle_stream_message(msg, metadata, emitter, tool_call_registry, pending_text)
                    _thinking_count = update_thinking_state(msg, emitter, _thinking_count, deep_thinking=deep_thinking)

                    if event_count % 20 == 0:
                        flushed_chunk = _flush_pending_text(emitter, pending_text)
                        if flushed_chunk:
                            last_ai_message += flushed_chunk
                    log_progress_snapshot(event_count, msg, pending_text, emitter)
                    _total_truncate_saved = process_tool_message_truncation(msg, emitter, _total_truncate_saved)

                    # Fallback：轻量模式检测到工具调用 → 切全量
                    is_ai_msg = isinstance(msg, (AIMessage, AIMessageChunk)) or type(msg).__name__ in ("AIMessage", "AIMessageChunk")
                    if _using_light_prompt and not _fallback_triggered and is_ai_msg:
                        if hasattr(msg, "tool_calls") and msg.tool_calls:
                            _fallback_triggered = True
                            _using_light_prompt = False
                            emitter._log("[fallback] 检测到工具调用 → 切全量 prompt + 工具", "warning")
                            _current_tools = _build_tools_for_llm()
                            system_prompt = build_fallback_system_prompt(TOOL_NAMES, TOOL_DESCRIPTIONS)
                            agent_inst = create_agent(llm, _current_tools, system_prompt=system_prompt)

                    conversation_messages.append(msg)
                    actual_iterations, _total_prune_saved = prune_tool_results_after_tool_call(
                        msg, conversation_messages, emitter, actual_iterations, _total_prune_saved,
                    )
                _stream_elapsed = round(time.perf_counter() - _stream_start, 3)
                emitter._log(f"agent.stream() 完成，共 {event_count} 事件，耗时 {_stream_elapsed}s", "info")
                if not cancelled:
                    flushed_tail = _flush_pending_text(emitter, pending_text)
                    if flushed_tail:
                        last_ai_message += flushed_tail
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
                    emitter._log(f"agent.stream() 超时 ({executor_timeout}s)", "error")
                    emitter.emit("agent_step_failed", {
                        "step": 1, "error": f"执行超时 ({executor_timeout}s)",
                        "elapsed_sec": round(time.perf_counter() - step_started, 3),
                    })
                    emitter.emit("agent_finished", {"status": "timeout", "error": "llm_timeout"})
                    timed_out = cancelled = True
                    return
                if stream_error is not None:
                    raise stream_error

        _run_stream_with_timeout(conversation_messages)

        # === 模型适配器补救：检测弱工具调用模型 ===
        if not cancelled and not timed_out and actual_iterations == 0 and last_ai_message:
            emitter._log("检测到模型输出文本但未调用工具，尝试适配器补救...", "info")
            adapter = select_adapter(model_config)
            emitter._log(f"选择适配器: {adapter.__class__.__name__}", "info")

            adapter_ctx = ModelAdapterContext(
                model_config=model_config,
                user_message=user_message,
                model_output_text=last_ai_message,
                event_count=event_count,
                actual_iterations=actual_iterations,
                tool_call_count=len(tool_call_registry),
            )
            adapter_ctx = adapter.handle_no_tool_calls(adapter_ctx)

            # 输出适配器日志
            for log_line in adapter_ctx.adapter_logs:
                emitter._log(log_line, "debug")

            if adapter_ctx.re_prompt_needed and adapter_ctx.re_prompt_message:
                emitter._log("适配器生成补救 prompt，重跑 agent.stream()", "info")
                emitter.emit("agent_message", {
                    "content": f"⚠️ 检测到模型未调用工具，正在重新引导...",
                    "kind": "progress",
                })
                conversation_messages.append(
                    HumanMessage(content=adapter_ctx.re_prompt_message)
                )
                emitter.emit("agent_step_started", {"step": 2, "message": "适配器补救"})
                _run_stream_with_timeout(conversation_messages)
                emitter._log(
                    f"补救后: {actual_iterations} 次工具调用迭代，"
                    f"{len(tool_call_registry)} 个注册表项",
                    "info",
                )

        # === 处理用户补充 ===
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
                "content": f"已收到用户补充（第 {supplement_round} 轮），正在继续完成任务。",
                "kind": "progress",
            })
            _run_stream_with_timeout(conversation_messages)

        from src.Infrastructure.adapters.agent.handlers.agent_result_reporter import (
            handle_timeout_or_cancelled, report_success_and_return,
        )
        early_result = handle_timeout_or_cancelled(timed_out, cancelled, emitter, step_started)
        if early_result is not None:
            return early_result

        return report_success_and_return(
            emitter=emitter, step_started=step_started,
            event_count=event_count, actual_iterations=actual_iterations,
            tool_call_registry=tool_call_registry,
            last_ai_message=last_ai_message,
            total_estimated_input_tokens=_total_estimated_input_tokens,
            total_truncate_saved=_total_truncate_saved,
            total_prune_saved=_total_prune_saved,
        )

    except Exception as exc:
        from src.Infrastructure.adapters.agent.handlers.agent_exception_handler import handle_agent_exception
        result = handle_agent_exception(
            exc=exc, emitter=emitter, model_config=model_config,
            tool_call_registry=tool_call_registry,
            conversation_messages=conversation_messages,
            step_started=step_started, actual_iterations=actual_iterations,
            create_chat_model_fn=create_chat_model,
            is_recursion_error_fn=_is_recursion_error,
            generate_recursion_summary_fn=_generate_recursion_summary,
        )
        return result.data


def get_available_tools() -> list[dict[str, str]]:
    return [{"name": n, "description": TOOL_DESCRIPTIONS.get(n, "")} for n in TOOL_NAMES]


__all__ = [
    "run_agent", "check_langchain_available", "get_available_tools",
    "create_agent", "init_chat_model",
    "HumanMessage", "AIMessage", "ToolMessage",
    "_create_chat_model", "_handle_stream_message",
    "_truncate_tool_message", "_prune_old_tool_results",
]
