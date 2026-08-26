from __future__ import annotations

from typing import Any

from src.Infrastructure.adapters.agent.agent_progress import AgentEventEmitter, build_tool_action_message

try:
    from langchain_core.messages import AIMessage, ToolMessage
except ImportError:
    class ToolMessage:  # type: ignore[no-redef]
        def __init__(self, content: str, tool_call_id: str = "", name: str = "") -> None:
            self.content = content
            self.tool_call_id = tool_call_id
            self.name = name

    class AIMessage:  # type: ignore[no-redef]
        def __init__(self, content: str = "", tool_calls: list[dict[str, Any]] | None = None) -> None:
            self.content = content
            self.tool_calls = tool_calls or []


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
                        "content": build_tool_action_message(tool_name, tool_args),
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


def _is_recursion_error(exc: Exception) -> bool:
    """检测是否为 LangGraph 递归限制错误。"""
    msg = str(exc).lower()
    return any(kw in msg for kw in (
        "recursion limit",
        "recursion_limit",
        "graph recursion",
        "max iterations",
        "maximum number of agent steps",
    ))


def _generate_recursion_summary(
    emitter: AgentEventEmitter,
    _create_chat_model: Any,
    model_config: dict[str, Any],
    tool_call_registry: dict[str, dict[str, Any]],
    conversation_messages: list,
    error_msg: str,
) -> dict[str, Any]:
    """在递归限制触发后，让 LLM 总结已完成的工作和遇到的问题。"""
    try:
        tool_lines = []
        for i, (tc_id, info) in enumerate(tool_call_registry.items(), 1):
            tool_name = info.get("tool_name", "unknown")
            tool_input = str(info.get("tool_input", ""))[:200]
            tool_result = str(info.get("tool_result", ""))[:200]
            status = "完成" if tool_result else "执行中"
            tool_lines.append(f"  {i}. `{tool_name}` — 输入: {tool_input[:80]} — {status}")

        tool_summary_text = "\n".join(tool_lines) if tool_lines else "  （无工具调用记录）"

        summary_prompt = f"""你是 TriMusicAgent。之前的执行因达到最大迭代次数而中止。

已完成的工具调用：
{tool_summary_text}

错误信息：{error_msg}

请用中文向用户说明：
1. 已完成了哪些工作
2. 遇到了什么问题（为什么会达到迭代上限）
3. 建议用户下一步怎么做（例如：补充更明确的指令、拆分任务等）

请用简洁的 markdown 格式回复，不要调用任何工具。"""

        llm = _create_chat_model(model_config)
        response = llm.invoke(summary_prompt)
        message = str(response.content) if hasattr(response, "content") else str(response)

        emitter._log(f"递归限制总结生成完成: {message[:100]}", "info")
        return {"message": message}
    except Exception as e:
        emitter._log(f"递归总结生成失败: {e}", "error")
        tool_count = len(tool_call_registry)
        tool_names = [info.get("tool_name", "unknown") for info in tool_call_registry.values()]
        return {
            "message": (
                f"本次任务已完成 {tool_count} 个工具调用"
                f"（{', '.join(tool_names)}），"
                f"但因达到最大迭代次数未能全部完成。"
                f"建议你检查一下任务是否陷入循环，并给出更明确的指令。"
            )
        }


__all__ = [
    "_handle_stream_message",
    "_flush_pending_text",
    "_generate_recursion_summary",
    "_is_recursion_error",
]
