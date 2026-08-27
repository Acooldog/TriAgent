"""Application.services — hexagonal facades for Presentation layer.

These services wrap Infrastructure adapters behind a stable Application-layer API.
Presentation modules (worker.py, cli.py) MUST only import from this package,
never from Infrastructure directly.
"""
from __future__ import annotations

from src.Application.services.platform_service import create_platform_adapter
from src.Application.services.config_service import ConfigService, config_service
from src.Application.services.agent_service import AgentService, agent_service
from src.Application.services.kugou_service import KugouService, kugou_service

__all__ = [
    "create_platform_adapter",
    "ConfigService",
    "config_service",
    "AgentService",
    "agent_service",
    "KugouService",
    "kugou_service",
]
