"""agent_progress — Agent 事件发射器 + 模块组合导出。

原 4 职责拆分：
- System Prompt → agent_prompts.py
- 意图检测 → agent_intent.py
- 行动消息 → agent_action_builder.py
- 事件发射 → 本文件 (AgentEventEmitter)
"""
from __future__ import annotations

import time
from typing import Any, Callable

# Re-export 拆分后的模块公共 API
from src.Infrastructure.adapters.agent.progress.agent_action_builder import (
    TOOL_ACTION_MESSAGES,
    build_initial_action_message,
    build_tool_action_message,
)
from src.Infrastructure.adapters.agent.progress.agent_intent import detect_intent
from src.Infrastructure.adapters.agent.progress.agent_prompts import (
    _SYSTEM_PROMPT_CHAT,
    _SYSTEM_PROMPT_FULL,
    _SYSTEM_PROMPT_SIMPLE,
    build_fallback_system_prompt,
    build_system_prompt,
)


class AgentEventEmitter:
    """Agent 事件发射器 — 将事件推送到 sink 回调。"""

    def __init__(self, event_sink: Callable[[str, dict[str, Any]], None]) -> None:
        self._sink = event_sink

    def _log(self, message: str, level: str = "info") -> None:
        try:
            self._sink("agent_log", {
                "level": level,
                "message": message,
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime()),
            })
        except Exception:
            pass

    def emit(self, event_type: str, payload: dict[str, Any] | None = None) -> None:
        self._log(f"发射事件: {event_type}", "debug")
        try:
            self._sink(event_type, payload or {})
        except Exception as exc:
            self._log(f"事件发射失败: {event_type} - {exc}", "error")


__all__ = [
    "AgentEventEmitter",
    "TOOL_ACTION_MESSAGES",
    "_SYSTEM_PROMPT_FULL",
    "_SYSTEM_PROMPT_SIMPLE",
    "_SYSTEM_PROMPT_CHAT",
    "build_system_prompt",
    "build_fallback_system_prompt",
    "build_initial_action_message",
    "build_tool_action_message",
    "detect_intent",
]