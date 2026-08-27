"""agent_recursion_handler — 递归限制错误检测与总结。

从 agent_message_handler.py 拆分而来，负责：
- 检测是否为 LangGraph 递归限制错误
- 让 LLM 总结已完成的工作和遇到的问题
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Any, Callable

if TYPE_CHECKING:
    from src.Infrastructure.adapters.agent.progress.agent_progress import AgentEventEmitter


def is_recursion_error(exc: Exception) -> bool:
    """检测是否为 LangGraph 递归限制错误。"""
    msg = str(exc).lower()
    return any(kw in msg for kw in (
        "recursion limit",
        "recursion_limit",
        "graph recursion",
        "max iterations",
        "maximum number of agent steps",
    ))


def generate_recursion_summary(
    emitter: AgentEventEmitter,
    create_chat_model: Callable[[dict[str, Any]], Any],
    model_config: dict[str, Any],
    tool_call_registry: dict[str, dict[str, Any]],
    conversation_messages: list[Any],
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

        llm = create_chat_model(model_config)
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
    "is_recursion_error",
    "generate_recursion_summary",
]