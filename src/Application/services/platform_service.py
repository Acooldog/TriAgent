"""Application.services.platform_service — platform adapter factory.

Wraps Infrastructure's concrete adapter factory so Presentation never
imports Infrastructure directly.
"""
from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from src.Domain.models import PlatformAdapter


def create_platform_adapter(platform_id: str) -> "PlatformAdapter":
    """Create a platform-specific decryption adapter.

    Args:
        platform_id: One of "qq", "kuwo", "kugou", "netease".

    Returns:
        A concrete PlatformAdapter implementation.

    Raises:
        ValueError: If the platform_id is not recognized.
    """
    normalized = (platform_id or "").strip().lower()
    if normalized == "qq":
        from src.Infrastructure.adapters.platforms.qq.adapter import QQPlatformAdapter
        return QQPlatformAdapter()
    if normalized == "kuwo":
        from src.Infrastructure.adapters.platforms.kuwo.adapter import KuwoPlatformAdapter
        return KuwoPlatformAdapter()
    if normalized == "kugou":
        from src.Infrastructure.adapters.platforms.kugou.adapter import KugouPlatformAdapter
        return KugouPlatformAdapter()
    if normalized == "netease":
        from src.Infrastructure.adapters.platforms.netease.adapter import NeteasePlatformAdapter
        return NeteasePlatformAdapter()
    raise ValueError(f"unsupported platform: {platform_id}")


__all__ = ["create_platform_adapter"]
