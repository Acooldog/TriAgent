from __future__ import annotations

import re
from typing import Any

try:
    from langchain.agents import create_agent
    from langchain.chat_models import init_chat_model
    from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, ToolMessage

    LANGCHAIN_AVAILABLE = True
except ImportError:
    LANGCHAIN_AVAILABLE = False

    def create_agent(*args: Any, **kwargs: Any) -> Any:
        raise ImportError("langchain is not installed")

    def init_chat_model(*args: Any, **kwargs: Any) -> Any:
        raise ImportError("langchain is not installed")

    class HumanMessage:
        def __init__(self, content: str) -> None:
            self.content = content

    class AIMessage:
        def __init__(self, content: str = "", tool_calls: list[dict[str, Any]] | None = None) -> None:
            self.content = content
            self.tool_calls = tool_calls or []

    class AIMessageChunk:
        def __init__(self, content: str = "", tool_calls: list[dict[str, Any]] | None = None) -> None:
            self.content = content
            self.tool_calls = tool_calls or []

    class ToolMessage:
        def __init__(self, content: str = "", name: str = "", tool_call_id: str = "") -> None:
            self.content = content
            self.name = name
            self.tool_call_id = tool_call_id


# === Token 估算（区分中英文字符） ===
# 中文字符 ≈ 1.5 tokens/char，英文字符 ≈ 0.25 tokens/char
_CJK_RE = re.compile(r'[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]')


def _char_weight(ch: str) -> float:
    """单字符权重：中文 1.5，英文/数字 0.25，标点 0.5。"""
    if _CJK_RE.match(ch):
        return 1.5
    if ch.isascii() and (ch.isalpha() or ch.isdigit()):
        return 0.25
    return 0.5


def estimate_tokens(text: str) -> int:
    """精确估算文本 token 数（区分中英文字符权重）。"""
    if not text:
        return 0
    total = sum(_char_weight(c) for c in text)
    return max(1, int(total + 0.5))


def estimate_messages_tokens(messages: list) -> tuple[int, int]:
    """估算消息列表的字符数和 token 数。"""
    total_chars = 0
    for m in messages:
        c = getattr(m, "content", "") or ""
        if isinstance(c, list):
            c = str(c)
        total_chars += len(str(c))
    total_tokens = 0
    for m in messages:
        c = getattr(m, "content", "") or ""
        if isinstance(c, list):
            c = str(c)
        total_tokens += estimate_tokens(str(c))
    return total_chars, total_tokens


# === AIMessage 裁剪（公共函数） ===
def prune_old_ai_messages(messages: list, keep_last_rounds: int = 3, max_chars_per_msg: int = 120) -> int:
    """裁剪旧轮次 AIMessage，只保留摘要。返回节省的字符数。

    规则：
    - 找到 AIMessage 工具调用轮次的索引
    - 保留最后 keep_last_rounds 轮的完整内容
    - 旧轮次的 AIMessage 只保留前 max_chars_per_msg 字符 + 工具调用摘要
    - 纯文本 AIMessage（无 tool_calls）也会被裁剪
    """
    # 找到所有 AIMessage（有 tool_calls）的轮次索引
    tool_round_indices: list[int] = []
    for i, m in enumerate(messages):
        is_ai = isinstance(m, AIMessage) or type(m).__name__ == "AIMessage"
        if is_ai and getattr(m, "tool_calls", None):
            tool_round_indices.append(i)

    if len(tool_round_indices) <= keep_last_rounds:
        return 0

    keep_from = tool_round_indices[-keep_last_rounds]
    total_saved = 0

    for i in range(keep_from):
        m = messages[i]
        is_ai = isinstance(m, AIMessage) or type(m).__name__ == "AIMessage"
        if not is_ai:
            continue
        orig_text = str(getattr(m, "content", ""))
        if not orig_text or orig_text.startswith("[助手回复摘要"):
            continue

        # 如果有工具调用，生成工具调用摘要
        tool_calls = getattr(m, "tool_calls", None)
        if tool_calls:
            tool_names = [str(tc.get("name", "?")) for tc in tool_calls if tc.get("name")]
            summary = f"[助手摘要: 调用了 {', '.join(tool_names[:3])}"
            if len(tool_names) > 3:
                summary += f" 等 {len(tool_names)} 个工具"
            summary += "]"
        else:
            # 纯文本回复：保留前 N 字符
            if len(orig_text) > max_chars_per_msg:
                summary = orig_text[:max_chars_per_msg].rstrip() + f"...(已裁剪，原始 {len(orig_text)} 字符)"
            else:
                continue

        saved = len(orig_text) - len(summary)
        if saved > 0:
            total_saved += saved
            try:
                m.content = summary
            except Exception:
                pass

    return total_saved


def create_chat_model_func(model_config: dict[str, Any]) -> Any:
    """Create chat model or raise RuntimeError when langchain is missing."""
    if not LANGCHAIN_AVAILABLE:
        raise RuntimeError("langchain 未安装")
    from src.Infrastructure.adapters.agent.config.agent_model import create_chat_model
    return create_chat_model(model_config, init_chat_model)


def build_tools_for_llm() -> list:
    """Return the full list of registered tools."""
    from src.Infrastructure.adapters.agent.tools.agent_tools import ALL_TOOLS
    return list(ALL_TOOLS)


def build_conversation_messages(conversation_history: list[dict[str, Any]] | None, user_message: str) -> list:
    """Convert plain-dict conversation history into langchain message objects."""
    messages: list = []
    if conversation_history:
        for msg in conversation_history:
            role = str(msg.get("role", ""))
            content = str(msg.get("content", ""))
            if role == "user":
                messages.append(HumanMessage(content=content))
            elif role == "assistant":
                messages.append(AIMessage(content=content))
    messages.append(HumanMessage(content=user_message))
    return messages


def check_langchain_available() -> bool:
    return LANGCHAIN_AVAILABLE


__all__ = [
    "LANGCHAIN_AVAILABLE",
    "create_agent",
    "init_chat_model",
    "HumanMessage",
    "AIMessage",
    "AIMessageChunk",
    "ToolMessage",
    "create_chat_model_func",
    "build_tools_for_llm",
    "build_conversation_messages",
    "check_langchain_available",
    "estimate_tokens",
    "estimate_messages_tokens",
    "prune_old_ai_messages",
    "_char_weight",
    "_CJK_RE",
]
