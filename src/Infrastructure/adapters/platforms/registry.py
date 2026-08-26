from __future__ import annotations

def build_platform_adapter(platform_id: str):
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
