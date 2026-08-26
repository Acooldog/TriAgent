from __future__ import annotations

import logging
import pathlib
from typing import Any

from src.Application.models import BatchRunConfig
from src.Infrastructure.cover_art_service import CoverArtService
from src.Infrastructure.transcoder import probe_media_summary, summary_to_log


def _cover_art_enabled(settings: dict[str, Any]) -> bool:
    value = settings.get("embed_cover_art", True)
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "y", "on"}
    return bool(value)


def _album_metadata_enabled(settings: dict[str, Any]) -> bool:
    value = settings.get("supplement_album_metadata", False)
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "y", "on"}
    return bool(value)


def _emit_event(config: BatchRunConfig, event_name: str, payload: dict[str, Any]) -> None:
    if config.event_sink is None:
        return
    try:
        config.event_sink(event_name, payload)
    except Exception:
        pass


def _maybe_attach_cover(
    logger: logging.Logger, config: BatchRunConfig, cover_service: CoverArtService,
    source_path: pathlib.Path, output_path: pathlib.Path, *, index: int, total_count: int,
) -> None:
    if output_path.suffix.lower() not in {".m4a", ".mp3", ".flac"}:
        return
    if not _cover_art_enabled(config.settings):
        logger.info("cover_skipped: %s reason=disabled_by_user", output_path.name)
        _emit_event(config, "cover_finished", {
            "platform_id": config.platform_id, "index": index, "total": total_count,
            "input_path": str(source_path), "output_path": str(output_path),
            "status": "disabled", "message": "已按设置跳过封面补写",
        })
        return
    logger.info("covering: %s source=%s mode=local_first cache_then_network may_be_slow=true",
                output_path.name, source_path.name)
    _emit_event(config, "cover_started", {
        "platform_id": config.platform_id, "index": index, "total": total_count,
        "input_path": str(source_path), "output_path": str(output_path),
        "message": "正在补封面（本地优先，可能会变慢）",
    })
    summary_before = probe_media_summary(output_path)
    result = cover_service.supplement_cover(str(output_path), str(source_path), summary_before)
    if result.status == "embedded":
        logger.info("Cover attached: %s source=%s image=%s | %s",
                    output_path.name, result.source or "", result.image_path or "",
                    summary_to_log(probe_media_summary(output_path)))
    elif result.status not in {"already_present", "unsupported"}:
        logger.info("Cover not attached: %s status=%s message=%s",
                    output_path.name, result.status, result.message)
    _emit_event(config, "cover_finished", {
        "platform_id": config.platform_id, "index": index, "total": total_count,
        "input_path": str(source_path), "output_path": str(output_path),
        "status": result.status, "source": result.source or "", "message": result.message,
    })


def _maybe_supplement_album_metadata(
    logger: logging.Logger, config: BatchRunConfig, cover_service: CoverArtService,
    source_path: pathlib.Path, output_path: pathlib.Path, *, index: int, total_count: int,
) -> None:
    if output_path.suffix.lower() not in {".m4a", ".wav"}:
        return
    if not _album_metadata_enabled(config.settings):
        logger.info("album_metadata_skipped: %s reason=disabled_by_user", output_path.name)
        _emit_event(config, "metadata_finished", {
            "platform_id": config.platform_id, "index": index, "total": total_count,
            "input_path": str(source_path), "output_path": str(output_path),
            "status": "disabled", "message": "已按设置跳过专辑信息补全",
        })
        return
    logger.info("metadata_supplementing: %s source=%s mode=local_first cache_then_network may_be_slow=true",
                output_path.name, source_path.name)
    _emit_event(config, "metadata_started", {
        "platform_id": config.platform_id, "index": index, "total": total_count,
        "input_path": str(source_path), "output_path": str(output_path),
        "message": "正在补专辑信息（本地优先，可能会变慢）",
    })
    summary_before = probe_media_summary(output_path)
    result = cover_service.supplement_album_metadata(str(output_path), str(source_path), summary_before)
    if result.status == "embedded":
        logger.info("Album metadata supplemented: %s source=%s fields=%s | %s",
                    output_path.name, result.source or "", ",".join(result.updated_fields),
                    summary_to_log(probe_media_summary(output_path)))
    elif result.status not in {"already_present", "unsupported"}:
        logger.info("Album metadata not supplemented: %s status=%s message=%s",
                    output_path.name, result.status, result.message)
    _emit_event(config, "metadata_finished", {
        "platform_id": config.platform_id, "index": index, "total": total_count,
        "input_path": str(source_path), "output_path": str(output_path),
        "status": result.status, "source": result.source or "",
        "updated_fields": list(result.updated_fields), "message": result.message,
    })


__all__ = [
    "_cover_art_enabled", "_album_metadata_enabled", "_emit_event",
    "_maybe_attach_cover", "_maybe_supplement_album_metadata",
]
