"""子 Agent 封装：接受精简工具集，复用 run_agent 的 LLM + stream + 超时机制。

设计思路:
- 不修改 run_agent 核心逻辑，而是在 run_sub_agent 内部调用 LangChain API
  直接创建 agent（和 run_agent 的做法一致），但传入精简工具集
- 每个子 Agent 有独立 agent_id，事件 payload 里都带 agent_id 字段
- 复用 agent_executor 的 _create_chat_model / _run_stream_with_timeout 逻辑
  （通过 import 复用，不复制代码）
- 子 Agent 不处理用户补充（那是主 Agent 的职责）

硬约束: 不修改 agent_executor.py 核心，新增代码独立
"""

from __future__ import annotations

import concurrent.futures
import logging
import threading
import time
from typing import Any, Callable

from src.Infrastructure.agent_progress import (
    AgentEventEmitter,
    build_tool_action_message,
)
from src.Infrastructure.agent_tools import TOOL_DESCRIPTIONS

try:
    from langchain.agents import create_agent
    from langchain_core.messages import AIMessage, HumanMessage
    _LANGCHAIN_AVAILABLE = True
except ImportError:
    _LANGCHAIN_AVAILABLE = False
    def create_agent(*args: Any, **kwargs: Any) -> Any:
        raise ImportError("langchain is not installed")
    class HumanMessage:
        def __init__(self, content: str) -> None: self.content = content
    class AIMessage:
        def __init__(self, content: str) -> None: self.content = content

logger = logging.getLogger("qkkdecrypt.infrastructure.multi_agent.sub_agent")


# 子 Agent 的精简 system prompt（从主 prompt 裁剪，强调角色职责）
def _build_sub_agent_system_prompt(role: str, role_desc: str, tool_names: list[str]) -> str:
    """为子 Agent 构建精简 system prompt。"""
    descriptions = "\n".join(f"- {name}: {TOOL_DESCRIPTIONS.get(name, '')}" for name in tool_names)
    base_prompt = f"""你是 TriMusicAgent 多 Agent 系统中的一个子 Agent，职责是「{role_desc}」。

## 核心约束
- 你只能使用系统分配给你的工具列表，不要幻想其他工具
- 只关注你的职责范围，不要做主 Agent（规划器）的工作
- 完成任务后用清晰的中文汇报：成功了多少、失败了多少、跳过了多少、关键输出路径
- 遇到工具失败时：① 报告当前已完成量 ② 自查失败原因 ③ 换思路继续，不要死磕同一路径
- 同一工具同思路连续失败 2 次后换思路
- 中文路径用 run_cli_safely 列表传参

## 汇报格式（完成时必须输出）
```
[子Agent汇报:{role}]
任务描述: <一句话>
成功: <N> 个
失败: <M> 个
跳过: <K> 个
关键输出: <路径列表，逗号分隔>
备注: <遇到的问题或特殊情况>
```

可用工具：
{descriptions}"""
    return base_prompt


def run_sub_agent(
    agent_id: str,
    role: str,
    task_description: str,
    tools: list,
    model_config: dict[str, Any],
    event_sink: Callable[[str, dict[str, Any]], None],
    max_iterations: int = 8,
    timeout: int = 600,
    stop_requested: Callable[[], bool] | None = None,
) -> dict[str, Any]:
    """运行一个子 Agent（精简版 run_agent）。

    Args:
        agent_id: 唯一标识（如 "decrypt-1"），事件 payload 中都带这个字段
        role: 角色名（decrypt/transcode/verify）
        task_description: 子 Agent 需要完成的具体任务（主 Agent 分派的）
        tools: 分配给这个子 Agent 的工具列表
        model_config: LLM 配置
        event_sink: 事件回调
        max_iterations: 最大工具调用迭代数（子 Agent 用更小值）
        timeout: 子 Agent 总超时秒数
        stop_requested: 外部停止信号

    Returns:
        {"status": "completed/failed/timeout/cancelled", "response_preview": str,
         "tool_calls_count": int, "elapsed_sec": float, "agent_id": str, "role": str}
    """
    # 在 event_sink 外面包一层，自动给所有事件加 agent_id
    def _wrapped_sink(event_type: str, payload: dict[str, Any]) -> None:
        payload = dict(payload) if isinstance(payload, dict) else {"data": payload}
        payload["agent_id"] = agent_id
        payload["role"] = role
        try:
            event_sink(event_type, payload)
        except Exception:
            pass

    emitter = AgentEventEmitter(_wrapped_sink)
    emitter.emit("sub_agent_started", {
        "agent_id": agent_id,
        "role": role,
        "message": task_description,
        "model": model_config.get("model", ""),
        "tools_count": len(tools),
    })

    if not _LANGCHAIN_AVAILABLE:
        emitter._log("langchain 不可用", "error")
        emitter.emit("sub_agent_finished", {"agent_id": agent_id, "status": "failed", "reason": "langchain_not_installed"})
        return {"agent_id": agent_id, "role": role, "status": "failed", "reason": "langchain_not_installed"}

    # 延迟导入（避免循环依赖）
    from src.Infrastructure.agent_executor import _create_chat_model, _handle_stream_message
    from src.Infrastructure.multi_agent.tool_registry import get_role_description

    tool_names = [getattr(t, "name", t.__name__) for t in tools]
    role_desc = get_role_description(role)
    system_prompt = _build_sub_agent_system_prompt(role, role_desc, tool_names)

    emitter._log(f"[sub_agent {agent_id}] 创建聊天模型...")
    llm = _create_chat_model(model_config)
    emitter._log(f"[sub_agent {agent_id}] 加载 {len(tools)} 个工具: {tool_names}")
    agent = create_agent(llm, tools, system_prompt=system_prompt)
    emitter._log(f"[sub_agent {agent_id}] Agent 已创建，开始执行任务...")

    # 构建对话
    conversation_messages: list = [HumanMessage(content=task_description)]
    graph_config = {"recursion_limit": max(min(max_iterations * 4, 32), 16)}
    cancel_event = threading.Event()

    tool_call_registry: dict[str, dict[str, Any]] = {}
    pending_text: list[str] = []
    last_ai_message = ""
    stream_error: Exception | None = None
    event_count = 0
    actual_iterations = 0
    cancelled = False
    timed_out = False

    step_started = time.perf_counter()

    def _stream_once(messages: list) -> None:
        nonlocal last_ai_message, stream_error, event_count, actual_iterations, cancelled
        try:
            for item in agent.stream(
                {"messages": messages},
                config=graph_config,
                stream_mode="messages",
            ):
                if cancel_event.is_set() or (stop_requested and stop_requested()):
                    cancelled = True
                    break

                event_count += 1
                if event_count % 100 == 0:
                    emitter._log(f"[sub_agent {agent_id}] 已处理 {event_count} 个流式事件...", "debug")

                msg, metadata = item
                _handle_stream_message(msg, metadata, emitter, tool_call_registry, pending_text)
                conversation_messages.append(msg)

                msg_type = type(msg).__name__
                if isinstance(msg, AIMessage) or msg_type == "AIMessage":
                    if hasattr(msg, "tool_calls") and msg.tool_calls:
                        actual_iterations += 1

            if not cancelled:
                flushed = "".join(pending_text).strip()
                if flushed:
                    last_ai_message = flushed
        except Exception as e:
            stream_error = e

    def _run_with_timeout(messages: list) -> None:
        nonlocal cancelled, timed_out
        cancel_event.clear()
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as tp:
            future = tp.submit(_stream_once, messages)
            try:
                future.result(timeout=timeout)
            except concurrent.futures.TimeoutError:
                cancel_event.set()
                emitter._log(f"[sub_agent {agent_id}] 超时 ({timeout}s)", "error")
                timed_out = True
                cancelled = True
            if stream_error is not None:
                raise stream_error

    emitter.emit("sub_agent_step_started", {"agent_id": agent_id, "step": 1})
    try:
        _run_with_timeout(conversation_messages)
    except Exception as exc:
        emitter._log(f"[sub_agent {agent_id}] 执行异常: {exc}", "error")
        emitter.emit("sub_agent_finished", {"agent_id": agent_id, "status": "failed", "error": str(exc)[:300]})
        return {
            "agent_id": agent_id, "role": role, "status": "failed",
            "error": str(exc)[:300],
            "elapsed_sec": round(time.perf_counter() - step_started, 3),
        }

    elapsed = round(time.perf_counter() - step_started, 3)

    if timed_out:
        result = {"agent_id": agent_id, "role": role, "status": "timeout", "elapsed_sec": elapsed}
        emitter.emit("sub_agent_finished", {"agent_id": agent_id, "status": "timeout", "elapsed_sec": elapsed})
        return result
    if cancelled:
        result = {"agent_id": agent_id, "role": role, "status": "cancelled", "elapsed_sec": elapsed}
        emitter.emit("sub_agent_finished", {"agent_id": agent_id, "status": "cancelled", "elapsed_sec": elapsed})
        return result

    # 完成
    emitter._log(f"[sub_agent {agent_id}] 完成: 迭代={actual_iterations} 耗时={elapsed}s")
    emitter.emit("sub_agent_finished", {
        "agent_id": agent_id, "status": "completed", "role": role,
        "tool_calls_count": len(tool_call_registry),
        "response_preview": str(last_ai_message)[:300],
        "elapsed_sec": elapsed,
    })
    return {
        "agent_id": agent_id, "role": role, "status": "completed",
        "tool_calls_count": len(tool_call_registry),
        "response_preview": str(last_ai_message)[:500],
        "elapsed_sec": elapsed,
    }
