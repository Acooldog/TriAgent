from __future__ import annotations

import concurrent.futures
import threading
import time
from typing import Any, Callable

from src.Infrastructure.adapters.agent.agent_helpers import (
    AIMessage,
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

    # 注入事件发射回调，让解密/转码工具能发 batch_* 进度事件
    set_event_sink(event_sink)

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
        _bu = str(model_config.get("base_url", ""))
        _ak = str(model_config.get("api_key", ""))
        if not _ak:
            emitter._log("LLM 配置错误：api_key 为空", "error")
            emitter.emit("agent_step_failed", {"step": 1, "error": "未配置 API Key"})
            emitter.emit("agent_finished", {"status": "error", "error": "missing_api_key"})
            return {"status": "error", "error": "missing_api_key"}
        try:
            import urllib.request as _ur
            _req = _ur.Request(_bu, method="HEAD", headers={"User-Agent": "TriMusicAgent/1.0"})
            _resp = _ur.urlopen(_req, timeout=8)
            emitter._log(f"模型服务可达 (HTTP {_resp.status})")
        except Exception as _url_exc:
            # HEAD 可能返回 405 (Method Not Allowed) — 那也是可达，忽略
            if hasattr(_url_exc, "code") and _url_exc.code in (405, 401, 403):
                emitter._log(f"模型服务可达 (HTTP {_url_exc.code})")
            else:
                emitter._log(f"模型服务不可达: {_url_exc}", "error")
                emitter.emit("agent_step_failed", {"step": 1, "error": f"模型服务不可达: {_url_exc}"})
                emitter.emit("agent_finished", {"status": "error", "error": "llm_unreachable"})
                return {"status": "error", "error": str(_url_exc)}

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
        _total_pruned_chars = 0            # 累计被截断/裁剪掉的字符数
        _total_truncate_saved = 0          # 截断工具输出省的字符
        _total_prune_saved = 0             # 裁剪旧轮次省的字符

        def _estimate_tokens(msgs: list) -> tuple[int, int]:
            """粗估 conversation_messages 的字符数和 token 数（1 token ≈ 3.5 字符，中英混合）。"""
            total_chars = 0
            for m in msgs:
                c = getattr(m, "content", "") or ""
                if isinstance(c, list):
                    c = str(c)
                total_chars += len(str(c))
            return total_chars, int(total_chars / 3.5)

        def _classify_msgs(msgs: list) -> str:
            """按消息类型分类统计，方便看哪种消息占空间。"""
            counts: dict[str, int] = {}
            for m in msgs:
                t = type(m).__name__
                c = getattr(m, "content", "") or ""
                counts[t] = counts.get(t, 0) + len(str(c))
            parts = [f"{k}:{v}ch" for k, v in counts.items()]
            return " ".join(parts)

        def _stream_once(messages: list) -> None:
            nonlocal last_ai_message, stream_error, event_count, actual_iterations, cancelled
            nonlocal _total_estimated_input_tokens, _total_truncate_saved, _total_prune_saved
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
                    if event_count % 50 == 0:
                        emitter._log(f"已处理 {event_count} 个流式事件...", "debug")
                    msg, metadata = item
                    _handle_stream_message(msg, metadata, emitter, tool_call_registry, pending_text)

                    # === 关键：ToolMessage content 截断，防止每轮重发长结果烧 token ===
                    if isinstance(msg, ToolMessage) or type(msg).__name__ == "ToolMessage":
                        _trunc_saved = _truncate_tool_message(msg, max_chars=300, keep_head=200)
                        if _trunc_saved > 0:
                            _total_truncate_saved += _trunc_saved
                            _name = getattr(msg, "name", "tool")
                            emitter._log(
                                f"[token] 截断 ToolMessage({_name}) 节省 {_trunc_saved} 字符 ≈ {int(_trunc_saved/3.5)} tokens",
                                "info",
                            )

                    conversation_messages.append(msg)

                    if isinstance(msg, AIMessage) or type(msg).__name__ == "AIMessage":
                        if hasattr(msg, "tool_calls") and msg.tool_calls:
                            actual_iterations += 1
                            # === 关键：每轮 AIMessage（触发了工具调用）后，清理旧 ToolMessage ===
                            _pr_saved = _prune_old_tool_results(conversation_messages, keep_last_rounds=2)
                            if _pr_saved > 0:
                                _total_prune_saved += _pr_saved
                                emitter._log(
                                    f"[token] 裁剪旧轮次节省 {_pr_saved} 字符 ≈ {int(_pr_saved/3.5)} tokens",
                                    "info",
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

        # === token 消耗汇总 ===
        _total_saved_chars = _total_truncate_saved + _total_prune_saved
        _total_saved_tokens = int(_total_saved_chars / 3.5)
        emitter._log(
            f"[token 汇总] 累计输入 ≈ {_total_estimated_input_tokens} tokens | "
            f"截断节省 ≈ {int(_total_truncate_saved/3.5)} tokens | "
            f"裁剪节省 ≈ {int(_total_prune_saved/3.5)} tokens | "
            f"**节流总计 ≈ {_total_saved_tokens} tokens**（相当于 {_total_saved_tokens/1000:.1f}K）",
            "info",
        )

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


def _truncate_tool_message(msg: Any, max_chars: int = 300, keep_head: int = 200) -> int:
    """直接修改 ToolMessage.content —— 超过 max_chars 就截断。返回节省的字符数。"""
    content = getattr(msg, "content", None)
    if content is None:
        return 0
    text = str(content)
    if len(text) <= max_chars:
        return 0
    original_len = len(text)
    truncated = text[:keep_head].rstrip() + f"...(已截断，原始 {original_len} 字符)"
    saved = original_len - len(truncated)
    try:
        msg.content = truncated
    except Exception:
        pass
    return saved


def _prune_old_tool_results(messages: list, keep_last_rounds: int = 2) -> int:
    """清理 conversation_messages 中的旧 ToolMessage。返回节省的字符数。"""
    tool_round_indices: list[int] = []
    for i, m in enumerate(messages):
        if isinstance(m, AIMessage) or type(m).__name__ == "AIMessage":
            tool_calls = getattr(m, "tool_calls", None)
            if tool_calls:
                tool_round_indices.append(i)

    if len(tool_round_indices) <= keep_last_rounds:
        return 0

    rounds_to_keep = tool_round_indices[-keep_last_rounds:]
    keep_from = rounds_to_keep[0]

    total_saved = 0
    for i in range(keep_from):
        m = messages[i]
        if isinstance(m, ToolMessage) or type(m).__name__ == "ToolMessage":
            orig_text = str(getattr(m, "content", ""))
            if "(已截断" in orig_text:
                continue
            name = getattr(m, "name", "tool")
            summary = f"[{name} 结果已省略 — 属于前序轮次]"
            saved = len(orig_text) - len(summary)
            if saved > 0:
                total_saved += saved
            try:
                m.content = summary
            except Exception:
                pass
    return total_saved


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
