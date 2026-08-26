"""Application.decrypt_post — post-decrypt helpers.

Previously depended directly on Infrastructure implementations
(OutputManifestRepository, transcode_file, ...). Now takes port
arguments so it depends only on Domain Protocols.
"""
from __future__ import annotations

import logging
import pathlib
import shutil
import time
from dataclasses import dataclass
from typing import Any

from src.Application.decrypt.decrypt_cover import (
    _album_metadata_enabled,
    _cover_art_enabled,
    _emit_event,
    _maybe_attach_cover,
    _maybe_supplement_album_metadata,
)
from src.Application.models import BatchRunConfig
from src.Application.transcode.transcode_batch_service import normalize_bitrate, normalize_sample_rate
from src.Domain.ports import ManifestPort, TranscodePort
from src.Domain.models import normalize_target_format as _domain_normalize_target


@dataclass(slots=True)
class _PreparedArtifact:
    index: int
    total_count: int
    input_path: pathlib.Path
    basename: str
    desired_target: str
    file_started: float
    working_path: pathlib.Path
    detected_container: str
    detail: dict[str, Any]
    decrypt_detail_timing: dict[str, float]
    file_timing: dict[str, float]


def _is_stop_requested(config: BatchRunConfig) -> bool:
    if config.stop_requested is None:
        return False
    try:
        return bool(config.stop_requested())
    except Exception:
        return False


def _cleanup_working_path(path: pathlib.Path | None) -> None:
    if path is None:
        return
    try:
        if path.exists():
            path.unlink()
    except Exception:
        pass


def _transcode_enabled(settings: dict[str, Any]) -> bool:
    value = settings.get("transcode_enabled", True)
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "y", "on"}
    return bool(value)


def _auto_transcode_after_decode(settings: dict[str, Any]) -> bool:
    value = settings.get("auto_transcode_after_decode", False)
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "y", "on"}
    return bool(value)


def _transcode_audio_profile(settings: dict[str, Any]) -> tuple[int | None, int | None]:
    return normalize_sample_rate(settings.get("transcode_sample_rate_hz")), normalize_bitrate(settings.get("transcode_bitrate_kbps"))


def _log_media_summary(logger: logging.Logger, label: str, path: pathlib.Path, transcode_port: TranscodePort) -> dict[str, Any]:
    summary = transcode_port.probe_media_summary(path)
    logger.info("%s: %s | %s", label, path.name, transcode_port.summary_to_log(summary))
    return summary


def _validate_summary(logger: logging.Logger, label: str, path: pathlib.Path, summary: dict[str, Any]) -> str | None:
    container = str(summary.get("container") or "bin")
    if container == "bin":
        logger.warning("%s produced an unrecognized audio container: %s", label, path)
        return "unrecognized_audio_container"
    return None


def _artifact_needs_transcode(desired_target: str, detected_container: str, transcode_port: TranscodePort) -> bool:
    target_format = _normalize_target_format(desired_target, transcode_port)
    return not (target_format == "auto" or detected_container == "bin" or target_format == detected_container)


def _normalize_final_target(desired_target: str, detected_container: str, *, transcode_enabled: bool, transcode_port: TranscodePort) -> str:
    if not transcode_enabled:
        return str(detected_container or "bin").lower()
    normalized = _normalize_target_format(desired_target, transcode_port)
    if normalized == "ogg":
        return "m4a"
    if normalized == "auto" and str(detected_container).lower() == "ogg":
        return "m4a"
    return normalized


def _normalize_target_format(value: str, transcode_port: TranscodePort) -> str:
    """Normalize target format via transcode_port (Domain Protocol)."""
    return transcode_port.normalize_target_format(value)


def _maybe_transcode(
    logger: logging.Logger, input_path: pathlib.Path, target_format: str,
    current_path: pathlib.Path, detected_container: str, file_timing: dict[str, float],
    transcode_port: TranscodePort,
    *, sample_rate_hz: int | None = None, bitrate_kbps: int | None = None,
) -> tuple[pathlib.Path, str, dict[str, Any] | None]:
    target_format = transcode_port.normalize_target_format(target_format)
    if target_format == "auto" or detected_container == "bin" or target_format == detected_container:
        return current_path, detected_container, None
    started = time.perf_counter()
    target_path = current_path.parent / f"{current_path.stem}.{target_format}"
    profile_parts: list[str] = []
    if sample_rate_hz:
        profile_parts.append(f"{sample_rate_hz}Hz")
    if bitrate_kbps:
        profile_parts.append(f"{bitrate_kbps}kbps")
    profile_text = f" [{' / '.join(profile_parts)}]" if profile_parts else ""
    logger.info("transcoding: %s -> %s%s", current_path.name, target_path.suffix, profile_text)
    meta = transcode_port.transcode_file(
        current_path, target_path, target_format,
        sample_rate_hz=sample_rate_hz, bitrate_kbps=bitrate_kbps,
    )
    logger.info("transcoding_ffmpeg: %s", meta.get("ffmpeg_path", ""))
    if current_path.exists():
        current_path.unlink()
    file_timing["transcode_sec"] = round(float(file_timing.get("transcode_sec", 0.0)) + (time.perf_counter() - started), 6)
    return target_path, target_format, meta


def _default_collision_choice(base_name: str, extension: str, existing_platform: str | None, config: BatchRunConfig) -> str:
    if not config.interactive or config.collision_resolver is None:
        return "suffix"
    return config.collision_resolver(base_name, extension, existing_platform)


def _publish_base_name(platform_id: str, input_path: pathlib.Path, base_name: str) -> str:
    source_ext = input_path.suffix.lower().lstrip(".")
    if platform_id == "kugou" and source_ext in {"kgg", "kgma", "kgm", "vpr"}:
        return f"{base_name}.{source_ext}"
    return base_name


def _resolve_publish_target(
    *, base_name: str, input_path: pathlib.Path, extension: str,
    platform_id: str, output_dir: pathlib.Path,
    manifest_repo: ManifestPort, config: BatchRunConfig,
) -> tuple[pathlib.Path, str, str | None]:
    publish_name = _publish_base_name(platform_id, input_path, base_name)
    target = output_dir / f"{publish_name}.{extension}"
    if not target.exists():
        return target, "direct", None
    existing_platform = manifest_repo.get_platform(target)
    if existing_platform in {None, platform_id}:
        return target, "existing_same_platform", existing_platform
    choice = _default_collision_choice(base_name, extension, existing_platform, config)
    if choice == "overwrite":
        return target, "overwrite", existing_platform
    if choice == "subdir":
        sub_target = output_dir / platform_id / f"{publish_name}.{extension}"
        return sub_target, "subdir", existing_platform
    return output_dir / f"{publish_name}.{platform_id}.{extension}", "suffix", existing_platform


def _publish_file(source_path: pathlib.Path, target_path: pathlib.Path) -> pathlib.Path:
    target_path.parent.mkdir(parents=True, exist_ok=True)
    temp_target = target_path.with_name(f".{target_path.stem}.publish.{time.time_ns()}{target_path.suffix}")
    if target_path.exists():
        target_path.unlink()
    try:
        source_path.replace(target_path)
    except OSError:
        if temp_target.exists():
            temp_target.unlink()
        shutil.copy2(str(source_path), str(temp_target))
        temp_target.replace(target_path)
        source_path.unlink(missing_ok=True)
    finally:
        temp_target.unlink(missing_ok=True)
    return target_path


__all__ = [
    "_PreparedArtifact", "_emit_event", "_is_stop_requested", "_cleanup_working_path",
    "_cover_art_enabled", "_album_metadata_enabled", "_transcode_enabled",
    "_auto_transcode_after_decode", "_transcode_audio_profile",
    "_log_media_summary", "_validate_summary",
    "_artifact_needs_transcode", "_normalize_final_target", "_maybe_transcode",
    "_maybe_attach_cover", "_maybe_supplement_album_metadata",
    "_default_collision_choice", "_publish_base_name",
    "_resolve_publish_target", "_publish_file",
]
