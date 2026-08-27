"""Application.services.config_service — config operations facade.

Wraps Infrastructure's config_repository so Presentation never
imports Infrastructure directly. Exposes both raw constants from Domain
and high-level config load/save/validate operations.
"""
from __future__ import annotations

import pathlib
from typing import Any

from src.Domain.constants import (
    CONFIG_NAMESPACE,
    DEFAULT_KUGOU_INPUT,
    DEFAULT_KUWO_INPUT,
    DEFAULT_NETEASE_INPUT,
    DEFAULT_QQ_INPUT,
    FLET_NOTE,
    LEGAL_NOTICE,
    PROJECT_ADDRESS,
    PROJECT_NAME_EN,
    PROJECT_NAME_ZH,
    PROJECT_QQ,
    QQMUSIC_ATTRIBUTION,
    TRANSCODE_BITRATE_OPTIONS,
    TRANSCODE_SAMPLE_RATE_OPTIONS,
)
from src.Domain.ports import RuntimePort

# Re-export constants for Presentation convenience
__all_constants__ = [
    "CONFIG_NAMESPACE", "PROJECT_NAME_EN", "PROJECT_NAME_ZH",
    "PROJECT_ADDRESS", "PROJECT_QQ", "QQMUSIC_ATTRIBUTION",
    "LEGAL_NOTICE", "FLET_NOTE",
    "DEFAULT_KUGOU_INPUT", "DEFAULT_KUWO_INPUT",
    "DEFAULT_QQ_INPUT", "DEFAULT_NETEASE_INPUT",
    "TRANSCODE_SAMPLE_RATE_OPTIONS", "TRANSCODE_BITRATE_OPTIONS",
]


class ConfigService:
    """High-level config operations for Presentation layer."""

    def discover_runtime_paths(self) -> RuntimePort:
        """Discover runtime paths (delegates to Infrastructure)."""
        from src.Infrastructure.adapters.runtime.runtime_paths import RuntimePaths
        return RuntimePaths.discover()

    def load(self, paths: RuntimePort) -> tuple[dict[str, Any], dict[str, Any]]:
        """Load and normalize configuration from disk."""
        from src.Infrastructure.config.config_repository import load_config
        return load_config(paths)

    def save(self, paths: RuntimePort, root: dict[str, Any], config: dict[str, Any]) -> None:
        """Save configuration to disk."""
        from src.Infrastructure.config.config_repository import save_config
        save_config(paths, root, config)

    def ensure_default(self, paths: RuntimePort) -> dict[str, Any]:
        """Save default config if missing, return it."""
        from src.Infrastructure.config.config_repository import save_default_config_if_missing
        return save_default_config_if_missing(paths)

    def validate_target_format(self, value: str) -> str:
        """Normalize and validate a target format string."""
        from src.Infrastructure.config.config_repository import validate_target_format
        return validate_target_format(value)

    def supported_target_formats(self) -> list[str]:
        """Return sorted list of supported target formats."""
        from src.Infrastructure.config.config_repository import supported_transcode_formats
        return supported_transcode_formats()

    def auto_find_kugou_key(self, paths: RuntimePort) -> pathlib.Path | None:
        """Auto-discover kugou key file path."""
        from src.Infrastructure.config.config_paths import auto_find_kugou_key
        return auto_find_kugou_key(paths)

    def auto_find_kgg_db_path(self) -> pathlib.Path | None:
        """Auto-discover KGMusicV3.db path."""
        from src.Infrastructure.config.config_paths import auto_find_kgg_db_path
        return auto_find_kgg_db_path()

    def default_kuwo_signature_path(self, paths: RuntimePort) -> pathlib.Path:
        """Return the default Kuwo signature file path."""
        from src.Infrastructure.config.config_paths import default_kuwo_signature_path
        return default_kuwo_signature_path(paths)

    def format_help_epilog(self, paths: RuntimePort) -> str:
        """Build CLI help epilog text."""
        from src.Infrastructure.config.config_repository import format_help_epilog
        return format_help_epilog(paths)

    def build_banner(self, paths: RuntimePort) -> str:
        """Build startup banner text."""
        from src.Infrastructure.config.config_repository import build_banner
        return build_banner(paths)


# Module-level singleton for convenience
config_service = ConfigService()

# Module-level convenience delegates for backward compatibility
def default_kuwo_signature_path(paths: RuntimePort) -> pathlib.Path:
    return config_service.default_kuwo_signature_path(paths)

def format_help_epilog(paths: RuntimePort) -> str:
    return config_service.format_help_epilog(paths)

def supported_transcode_formats() -> list[str]:
    return config_service.supported_target_formats()

def validate_target_format(value: str) -> str:
    return config_service.validate_target_format(value)

__all__ = ["ConfigService", "config_service",
           "default_kuwo_signature_path", "format_help_epilog",
           "supported_transcode_formats", "validate_target_format",
           ] + __all_constants__
