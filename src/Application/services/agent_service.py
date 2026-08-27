"""Application.services.agent_service — agent execution facade.

Wraps Infrastructure's agent_executor and agent_tools so Presentation
never imports Infrastructure directly.
"""
from __future__ import annotations

from typing import Any, Callable


class AgentService:
    """Application-level facade for agent lifecycle operations."""

    def run_agent(
        self,
        user_message: str,
        model_config: dict[str, Any],
        event_sink: Callable[[str, dict[str, Any]], None],
        max_iterations: int = 15,
        stop_requested: Callable[[], bool] | None = None,
        announce_start: bool = True,
        consume_supplements: Callable[[], list[str]] | None = None,
        conversation_history: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Execute the agent loop. See Infrastructure adapter for full docs."""
        from src.Infrastructure.adapters.agent.agent_executor import run_agent as _run
        return _run(
            user_message=user_message,
            model_config=model_config,
            event_sink=event_sink,
            max_iterations=max_iterations,
            stop_requested=stop_requested,
            announce_start=announce_start,
            consume_supplements=consume_supplements,
            conversation_history=conversation_history,
        )

    def check_langchain_available(self) -> bool:
        """Check if langchain is installed and importable."""
        from src.Infrastructure.adapters.agent.agent_helpers import check_langchain_available
        return check_langchain_available()

    def set_ask_user_callback(self, callback: Callable[[str, list[str]], str]) -> None:
        """Inject the ask_user callback for blocking user questions."""
        from src.Infrastructure.adapters.agent.tools.agent_tools import set_ask_user_callback
        set_ask_user_callback(callback)

    def set_permission_mode(self, mode: str) -> None:
        """Set the global permission mode for agent tools."""
        from src.Infrastructure.adapters.agent.tools.agent_tools import set_permission_mode
        set_permission_mode(mode)

    def build_initial_action_message(self, user_message: str) -> str:
        """Build the initial progress message shown before agent starts."""
        from src.Infrastructure.adapters.agent.progress.agent_progress import build_initial_action_message
        return build_initial_action_message(user_message)


# Module-level singleton for convenience
agent_service = AgentService()

__all__ = ["AgentService", "agent_service"]
