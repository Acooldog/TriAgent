"""Application.services.kugou_service — Kugou key refresh facade.

Wraps Infrastructure's kugou_key_refresh so Presentation never
imports Infrastructure directly.
"""
from __future__ import annotations

import pathlib
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from src.Domain.ports import RuntimePort


class KugouService:
    """Application-level facade for Kugou key management."""

    def refresh_key(
        self,
        paths: "RuntimePort",
        *,
        destination: pathlib.Path | None = None,
    ):
        """Refresh the kugou_key.xz file.

        Args:
            paths: Runtime paths (RuntimePort implementation).
            destination: Optional output path; defaults to assets dir.

        Returns:
            KugouKeyRefreshResult with output_path, source_url, file_size, sha256.
        """
        from src.Infrastructure.adapters.platforms.kugou.key.kugou_key_refresh import refresh_kugou_key
        return refresh_kugou_key(paths, destination=destination)

    def default_refreshed_key_path(self, paths: "RuntimePort") -> pathlib.Path:
        """Return the default path for a refreshed kugou key."""
        from src.Infrastructure.adapters.platforms.kugou.key.kugou_key_refresh import default_refreshed_kugou_key_path
        return default_refreshed_kugou_key_path(paths)


# Module-level singleton for convenience
kugou_service = KugouService()

__all__ = ["KugouService", "kugou_service"]
