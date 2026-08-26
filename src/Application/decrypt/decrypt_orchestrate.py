"""Application.decrypt_orchestrate — finalize & transcode orchestration.

Previously depended directly on Infrastructure implementations
(CoverArtService, OutputManifestRepository, transcode_file). Now takes port
arguments so it depends only on Domain Protocols.
"""
from __future__ import annotations

import logging
import pathlib
import time
from typing import Any

from src.Application.decrypt.decrypt_timing import _copy_timing
from src.Domain.ports import CoverArtPort, ManifestPort, TranscodePort
from src.Application.decrypt.decrypt_post import (
    _PreparedArtifact,
    _artifact_needs_transcode,
    _cleanup_working_path,
    _emit_event,
    _is_stop_requested,
    _log_media_summary,
    _maybe_attach_cover,
    _maybe_supplement_album_metadata,
    _maybe_transcode,
    _normalize_final_target,
    _publish_file,
    _resolve_publish_target,
    _transcode_audio_profile,
    _transcode_enabled,
    _validate_summary,
    _auto_transcode_after_decode,
)
from src.Application.models import BatchRunConfig, FileResult
from src.Infrastructure.adapters.runtime.runtime_logging import timing_text


def _resolve_batch_transcode_choice(
    logger: logging.Logger,
    config: BatchRunConfig,
    prepared_artifacts: list[_PreparedArtifact],
    transcode_port: TranscodePort | None = None,
    *,
    failed_count: int,
    stopped_early: bool,
) -> tuple[bool, list[_PreparedArtifact]]:
    pending = [item for item in prepared_artifacts if _artifact_needs_transcode(item.desired_target, item.detected_container, transcode_port)]
    if failed_count > 0 or stopped_early:
        logger.info(
            "batch_transcode_skipped: pending=%d failed=%d stopped=%s",
            len(pending), failed_count, stopped_early,
        )
        return False, pending

    def _format_target(value: str) -> str:
        if transcode_port is not None and hasattr(transcode_port, "normalize_target_format"):
            return transcode_port.normalize_target_format(value)  # type: ignore[union-attr]
        from src.Infrastructure.adapters.media.transcode.transcoder import normalize_target_format as _nf
        return _nf(value)

    payload = {
        "platform_id": config.platform_id,
        "ready_count": len(prepared_artifacts),
        "pending_count": len(pending),
        "has_pending_transcode": bool(pending),
        "transcode_enabled_setting": _transcode_enabled(config.settings),
        "pending_files": [item.input_path.name for item in pending],
        "pending_targets": [
            {
                "input_path": str(item.input_path),
                "detected_container": item.detected_container,
                "desired_target": _format_target(item.desired_target),
            }
            for item in pending
        ],
    }
    _emit_event(config, "batch_decode_finished", dict(payload))
    if pending and _auto_transcode_after_decode(config.settings):
        logger.info("batch_transcode_auto_enabled: pending=%d", len(pending))
        _emit_event(config, "batch_transcode_decided", {
            **payload, "should_transcode": True, "decision_mode": "auto", "remember_choice": True,
        })
        return True, pending

    resolver = config.transcode_confirmation_resolver
    if resolver is None:
        logger.info("batch_transcode_prompt_unavailable: pending=%d", len(pending))
        _emit_event(config, "batch_transcode_decided", {
            **payload, "should_transcode": False, "decision_mode": "unavailable", "remember_choice": False,
        })
        return False, pending

    _emit_event(config, "batch_transcode_confirmation_needed", dict(payload))
    response = resolver(dict(payload))
    should_transcode = bool(response[0]) if response and pending else False
    remember_choice = bool(response[1]) if response else False
    logger.info(
        "batch_transcode_prompt_result: pending=%d should_transcode=%s remember=%s",
        len(pending), should_transcode, remember_choice,
    )
    _emit_event(config, "batch_transcode_decided", {
        **payload, "should_transcode": should_transcode, "decision_mode": "prompt", "remember_choice": remember_choice,
    })
    return should_transcode, pending


def _finalize_prepared_artifact(
    logger: logging.Logger,
    config: BatchRunConfig,
    cover_service: CoverArtPort,
    manifest_repo: ManifestPort,
    prepared: _PreparedArtifact,
    transcode_port: TranscodePort | None = None,
    *,
    should_transcode: bool,
    transcode_sample_rate_hz: int | None,
    transcode_bitrate_kbps: int | None,
    file_started: float,
) -> tuple[str, FileResult]:
    working_path = prepared.working_path
    final_extension = prepared.detected_container
    transcode_meta: dict[str, Any] | None = None
    try:
        if should_transcode and _artifact_needs_transcode(prepared.desired_target, prepared.detected_container, transcode_port):
            working_path, final_extension, transcode_meta = _maybe_transcode(
                logger, prepared.input_path, prepared.desired_target, working_path,
                prepared.detected_container, prepared.file_timing, transcode_port,
                sample_rate_hz=transcode_sample_rate_hz, bitrate_kbps=transcode_bitrate_kbps,
            )
            _emit_event(config, "batch_transcode_progress", {
                "platform_id": config.platform_id,
                "index": prepared.index, "total": prepared.total_count,
                "input_path": str(prepared.input_path),
                "output_path": str(working_path),
                "target_format": final_extension,
                "message": f"正在统一转码：{prepared.input_path.name}",
            })

        if _is_stop_requested(config):
            _cleanup_working_path(working_path)
            raise RuntimeError("stopped_by_user")

        _maybe_attach_cover(logger, config, cover_service, prepared.input_path, working_path,
                            index=prepared.index, total_count=prepared.total_count,
                            transcode_port=transcode_port)
        if _is_stop_requested(config):
            _cleanup_working_path(working_path)
            raise RuntimeError("stopped_by_user")

        _maybe_supplement_album_metadata(logger, config, cover_service, prepared.input_path, working_path,
                                         index=prepared.index, total_count=prepared.total_count,
                                         transcode_port=transcode_port)
        if _is_stop_requested(config):
            _cleanup_working_path(working_path)
            raise RuntimeError("stopped_by_user")

        final_summary = _log_media_summary(logger, "Final media summary", working_path, transcode_port)
        summary_error = _validate_summary(logger, "Final publish", working_path, final_summary)
        if summary_error:
            raise RuntimeError(summary_error)

        publish_started = time.perf_counter()
        publish_hint = _resolve_publish_target(
            base_name=prepared.basename, input_path=prepared.input_path,
            extension=final_extension, platform_id=config.platform_id,
            output_dir=config.output_dir, manifest_repo=manifest_repo, config=config,
        )
        final_target, publish_mode, existing_platform = publish_hint
        if final_target.exists() and publish_mode == "existing_same_platform":
            _cleanup_working_path(working_path)
            prepared.file_timing["publish_sec"] = round(time.perf_counter() - publish_started, 6)
            prepared.file_timing["total_sec"] = round(time.perf_counter() - file_started, 6)
            logger.info("skip_duplicate_after_decode: %s -> %s", prepared.input_path.name, final_target)
            logger.info("[timing] file_done [%d/%d] %s reason=already_decrypted %s",
                        prepared.index, prepared.total_count, prepared.input_path.name,
                        timing_text(prepared.file_timing))
            result = FileResult(
                ok=True, skipped=True, platform_id=config.platform_id,
                input_path=str(prepared.input_path), output_path=str(final_target),
                reason="already_decrypted", timing=_copy_timing(prepared.file_timing),
                decrypt_detail_timing=prepared.decrypt_detail_timing, payload=dict(prepared.detail),
            )
            _emit_event(config, "file_finished", {
                "platform_id": config.platform_id, "index": prepared.index, "total": prepared.total_count,
                "result": "already_decrypted", "output_path": str(final_target),
                "timing": dict(result.timing), "decrypt_detail_timing": dict(result.decrypt_detail_timing),
            })
            return "already_decrypted", result

        published = _publish_file(working_path, final_target)
        prepared.file_timing["publish_sec"] = round(time.perf_counter() - publish_started, 6)
        prepared.file_timing["total_sec"] = round(time.perf_counter() - file_started, 6)
        manifest_repo.set_platform(published, config.platform_id)
        payload = dict(prepared.detail)
        payload.update({
            "detected_container": prepared.detected_container,
            "final_extension": final_extension,
            "publish_mode": publish_mode,
            "existing_platform": existing_platform,
            "transcode_mode": "batch_post_decode" if should_transcode else "raw_publish",
        })
        if transcode_meta is not None:
            payload["transcode"] = transcode_meta
        logger.info("success: %s -> %s", prepared.input_path.name, published)
        logger.info("[timing] file_done [%d/%d] %s reason=success %s",
                    prepared.index, prepared.total_count, prepared.input_path.name,
                    timing_text(prepared.file_timing))
        result = FileResult(
            ok=True, skipped=False, platform_id=config.platform_id,
            input_path=str(prepared.input_path), output_path=str(published),
            timing=_copy_timing(prepared.file_timing),
            decrypt_detail_timing=prepared.decrypt_detail_timing, payload=payload,
        )
        _emit_event(config, "file_finished", {
            "platform_id": config.platform_id, "index": prepared.index, "total": prepared.total_count,
            "result": "success", "output_path": str(published),
            "timing": dict(result.timing), "decrypt_detail_timing": dict(result.decrypt_detail_timing),
            "payload": dict(payload),
        })
        return "success", result
    except Exception as exc:
        _cleanup_working_path(working_path)
        prepared.file_timing["total_sec"] = round(time.perf_counter() - file_started, 6)
        logger.warning("failed: %s reason=%s", prepared.input_path.name, exc)
        logger.info("[timing] file_done [%d/%d] %s reason=%s %s",
                    prepared.index, prepared.total_count, exc,
                    timing_text(prepared.file_timing))
        result = FileResult(
            ok=False, skipped=False, platform_id=config.platform_id,
            input_path=str(prepared.input_path), reason=str(exc),
            timing=_copy_timing(prepared.file_timing),
        )
        _emit_event(config, "file_finished", {
            "platform_id": config.platform_id, "index": prepared.index, "total": prepared.total_count,
            "result": "failed", "input_path": str(prepared.input_path), "reason": str(exc),
            "timing": dict(result.timing),
        })
        return "failed", result


__all__ = [
    "_resolve_batch_transcode_choice",
    "_finalize_prepared_artifact",
]
