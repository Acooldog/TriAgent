"""Agent progress subpackage — progress tracking and stream processing.

SRP 拆分结构：
- agent_progress.py     → AgentEventEmitter + 组合导出
- agent_prompts.py      → System prompt 定义与组装
- agent_intent.py       → 意图检测
- agent_action_builder.py → 工具行动消息构建
- agent_message_handler.py → 流式消息处理（对外 API 门面）
- agent_delta_detector.py  → Delta 模式检测
- agent_recursion_handler.py → 递归错误检测与总结
"""
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
from src.Infrastructure.adapters.agent.progress.agent_message_handler import (
    _flush_pending_text,
    _generate_recursion_summary,
    _handle_stream_message,
    _is_recursion_error,
    reset_delta_mode,
)

__all__ = [
    "AgentEventEmitter",
    "build_initial_action_message",
    "build_system_prompt",
    "log_progress_snapshot",
    "prune_tool_results_after_tool_call",
    "process_tool_message_truncation",
    "update_thinking_state",
    "_flush_pending_text",
    "_generate_recursion_summary",
    "_handle_stream_message",
    "_is_recursion_error",
    "reset_delta_mode",
]