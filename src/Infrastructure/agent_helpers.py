from __future__ import annotations

from typing import Any

try:
    from langchain.agents import create_agent
    from langchain.chat_models import init_chat_model
    from langchain_core.messages import AIMessage, HumanMessage

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
        def __init__(self, content: str) -> None:
            self.content = content


def create_chat_model_func(model_config: dict[str, Any]) -> Any:
    """Create chat model or raise RuntimeError when langchain is missing."""
    if not LANGCHAIN_AVAILABLE:
        raise RuntimeError("langchain 未安装")
    from src.Infrastructure.agent_model import create_chat_model
    return create_chat_model(model_config, init_chat_model)


def build_tools_for_llm() -> list:
    """Return the full list of registered tools."""
    from src.Infrastructure.agent_tools import ALL_TOOLS
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
    "create_chat_model_func",
    "build_tools_for_llm",
    "build_conversation_messages",
    "check_langchain_available",
]
