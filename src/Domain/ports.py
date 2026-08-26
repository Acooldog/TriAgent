from __future__ import annotations

import pathlib
from dataclasses import dataclass
from typing import Any, Callable, Protocol


# ---------------------------------------------------------------------------
# RuntimePort — 路径发现 + 日志目录
# ---------------------------------------------------------------------------

class RuntimePort(Protocol):
    """Port for runtime path discovery and directory management."""

    root_dir: pathlib.Path
    log_dir: pathlib.Path
    output_dir: pathlib.Path
    plugins_dir: pathlib.Path
    output_manifest: pathlib.Path

    @classmethod
    def discover(cls) -> "RuntimePort": ...

    def ensure_runtime_dirs(self) -> None: ...


# ---------------------------------------------------------------------------
# ConfigPort — 配置加载 & 保存
# ---------------------------------------------------------------------------

class ConfigPort(Protocol):
    """Port for reading / writing JSON configuration."""

    def load_config(self, paths: RuntimePort) -> tuple[dict[str, Any], dict[str, Any]]: ...
    def save_config(self, paths: RuntimePort, root: dict[str, Any], config: dict[str, Any]) -> None: ...


# ---------------------------------------------------------------------------
# CoverArtPort — 封面搜索 & 嵌入
# ---------------------------------------------------------------------------

@dataclass(slots=True)
class CoverArtResult:
    """Result DTO for cover art supplementation."""
    status: str
    message: str
    image_path: str | None = None
    source: str | None = None


@dataclass(slots=True)
class AlbumMetadataResult:
    """Result DTO for album metadata supplementation."""
    status: str
    message: str
    source: str | None = None
    updated_fields: tuple[str, ...] = ()


class CoverArtPort(Protocol):
    """Port for supplementing cover art and album metadata."""

    def supplement_cover(
        self,
        audio_path: str | pathlib.Path,
        source_file_path: str | pathlib.Path,
        media_summary: dict[str, Any] | None = None,
    ) -> CoverArtResult: ...

    def supplement_album_metadata(
        self,
        audio_path: str | pathlib.Path,
        source_file_path: str | pathlib.Path,
        media_summary: dict[str, Any] | None = None,
    ) -> AlbumMetadataResult: ...


# ---------------------------------------------------------------------------
# TranscodePort — 音频转码 + 媒体探测
# ---------------------------------------------------------------------------

class TranscodePort(Protocol):
    """Port for ffmpeg-based audio transcode and media probing."""

    def transcode_file(
        self,
        input_path: pathlib.Path,
        output_path: pathlib.Path,
        target_format: str,
        *,
        sample_rate_hz: int | None = None,
        bitrate_kbps: int | None = None,
    ) -> dict[str, Any]: ...

    def probe_media_summary(self, path: pathlib.Path) -> dict[str, Any]: ...

    def summary_to_log(self, summary: dict[str, Any]) -> str: ...

    def normalize_target_format(self, value: str) -> str: ...


# ---------------------------------------------------------------------------
# ManifestPort — 输出清单读写
# ---------------------------------------------------------------------------

class ManifestPort(Protocol):
    """Port for tracking which platform produced each output file."""

    def load(self) -> dict[str, Any]: ...
    def save(self, payload: dict[str, Any]) -> None: ...
    def get_platform(self, output_path: pathlib.Path) -> str | None: ...
    def set_platform(self, output_path: pathlib.Path, platform_id: str) -> None: ...
    def remove(self, output_path: pathlib.Path) -> None: ...


# ---------------------------------------------------------------------------
# LoggingPort — 运行时日志、计时与批处理报告
# ---------------------------------------------------------------------------

class LoggingPort(Protocol):
    """Port for application-level logging, timing formatting, and batch report writing."""

    def setup_logger(self, paths: RuntimePort) -> tuple[Any, pathlib.Path, pathlib.Path]: ...
    def timing_text(self, value: dict[str, float]) -> str: ...
    def write_batch_reports(
        self,
        log_dir: pathlib.Path,
        platform_id: str,
        results: list[Any],
        summary: Any,
    ) -> tuple[pathlib.Path, pathlib.Path]: ...


# ---------------------------------------------------------------------------
# PlatformPort — 平台适配器
# ---------------------------------------------------------------------------
# Note: The Protocol class itself is exposed as ``PlatformAdapter`` in
# ``Domain.models``. ``PlatformPort`` is a semantic alias kept here so the
# hexagonal vocabulary (``PlatformPort``, ``ManifestPort``, ...) is consistent.
from src.Domain.models import PlatformAdapter as PlatformPort  # noqa: E402,F401


# ---------------------------------------------------------------------------
# ApplicationPorts — 聚合 ports 的容器（用于依赖注入）
# ---------------------------------------------------------------------------

@dataclass(slots=True)
class ApplicationPorts:
    """Bundle of infrastructure adapters injected into the Application layer."""

    runtime: RuntimePort
    cover_service: CoverArtPort
    manifest_repo: ManifestPort
    transcode: TranscodePort
    logging: LoggingPort


__all__ = [
    "RuntimePort",
    "ConfigPort",
    "CoverArtPort",
    "CoverArtResult",
    "AlbumMetadataResult",
    "TranscodePort",
    "ManifestPort",
    "LoggingPort",
    "ApplicationPorts",
]
