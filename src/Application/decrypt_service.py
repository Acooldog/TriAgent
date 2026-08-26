from __future__ import annotations

import logging
import pathlib
import shutil
import time
from typing import Any

from src.Application.decrypt_timing import (
    _accumulate, _artifact_timing, _copy_timing, _log_decrypt_detail,
    _new_timing, _throughput_mib,
)
from src.Application.decrypt_post import (
    _PreparedArtifact, _artifact_needs_transcode, _cleanup_working_path,
    _emit_event, _is_stop_requested, _log_media_summary,
    _normalize_final_target, _resolve_publish_target, _transcode_audio_profile,
    _transcode_enabled, _validate_summary,
)
from src.Application.decrypt_orchestrate import (
    _finalize_prepared_artifact, _resolve_batch_transcode_choice,
)
from src.Application.models import BatchRunConfig, BatchSummary, FileResult, PlatformAdapter, TIMING_STAGE_KEYS
from src.Infrastructure.cover_art_service import CoverArtService
from src.Infrastructure.output_manifest_repository import OutputManifestRepository
from src.Infrastructure.runtime_logging import setup_logger, timing_text, write_batch_reports
from src.Infrastructure.runtime_paths import RuntimePaths


AUDIO_OUTPUT_EXTS = {".flac", ".wav", ".mp3", ".m4a"}


def run_batch(config: BatchRunConfig, adapter: PlatformAdapter) -> int:
    paths = RuntimePaths.discover()
    paths.ensure_runtime_dirs()
    logger, log_path, log_dir = setup_logger(paths)
    cover_service = CoverArtService()
    manifest_repo = OutputManifestRepository(paths.output_manifest)
    batch_started = time.perf_counter()
    work_dir = log_dir / "work" / f"{config.platform_id}_{int(batch_started)}"
    work_dir.mkdir(parents=True, exist_ok=True)

    logger.info("runtime_dir: %s", paths.root_dir)
    logger.info("platform: %s", config.platform_id)
    logger.info("input_path: %s", config.input_path)
    logger.info("output_dir: %s", config.output_dir)
    logger.info("recursive: %s", config.recursive)

    files = adapter.collect_files(config.input_path, config.recursive)
    logger.info("candidate_files: %d", len(files))
    _emit_event(config, "batch_started", {
        "platform_id": config.platform_id, "candidate_count": len(files),
        "input_path": str(config.input_path), "output_dir": str(config.output_dir),
    })

    timing_batch_total = _new_timing()
    results: list[FileResult] = []
    prepared_artifacts: list[_PreparedArtifact] = []
    success_count = skipped_count = failed_count = 0
    stopped_early = False
    transcode_enabled_setting = _transcode_enabled(config.settings)
    transcode_sample_rate_hz, transcode_bitrate_kbps = _transcode_audio_profile(config.settings)

    for index, file_path in enumerate(files, start=1):
        if _is_stop_requested(config):
            stopped_early = True
            logger.info("stop_requested_before_file: index=%d total=%d", index, len(files))
            break
        file_started = time.perf_counter()
        file_timing = _new_timing()
        scan_started = time.perf_counter()
        logger.info("[%d/%d] decrypting: %s", index, len(files), file_path)
        _emit_event(config, "file_started", {
            "platform_id": config.platform_id, "index": index, "total": len(files),
            "input_path": str(file_path),
        })
        file_timing["scan_sec"] = round(time.perf_counter() - scan_started, 6)

        basename = adapter.output_basename(file_path)
        predicted_ext = adapter.predicted_extension(file_path, config.settings)
        desired_target = adapter.desired_target_format(file_path, config.settings)

        dedupe_started = time.perf_counter()
        if predicted_ext and not transcode_enabled_setting:
            hinted_target, hinted_mode, _ = _resolve_publish_target(
                base_name=basename, input_path=file_path, extension=predicted_ext,
                platform_id=config.platform_id, output_dir=config.output_dir,
                manifest_repo=manifest_repo, config=config,
            )
            if hinted_target.exists() and hinted_mode == "existing_same_platform":
                skipped_count += 1
                file_timing["dedupe_sec"] = round(time.perf_counter() - dedupe_started, 6)
                file_timing["total_sec"] = round(time.perf_counter() - file_started, 6)
                _accumulate(timing_batch_total, file_timing)
                logger.info("skip_duplicate: %s -> %s", file_path.name, hinted_target)
                logger.info("[timing] file_done [%d/%d] %s reason=already_decrypted %s",
                            index, len(files), file_path.name, timing_text(file_timing))
                result = FileResult(ok=True, skipped=True, platform_id=config.platform_id,
                                   input_path=str(file_path), output_path=str(hinted_target),
                                   reason="already_decrypted", timing=_copy_timing(file_timing))
                results.append(result)
                _emit_event(config, "file_finished", {
                    "platform_id": config.platform_id, "index": index, "total": len(files),
                    "result": "already_decrypted", "output_path": str(hinted_target),
                    "timing": dict(result.timing),
                })
                continue
        file_timing["dedupe_sec"] = round(time.perf_counter() - dedupe_started, 6)

        working_path: pathlib.Path | None = None
        try:
            decrypt_settings = dict(config.settings)
            if config.platform_id == "qq":
                decrypt_settings["qq_variant_notifier"] = lambda payload, *, _index=index, _total=len(files), _path=file_path: _emit_event(
                    config, "variant_started", {
                        "platform_id": config.platform_id,
                        "index": _index, "total": _total,
                        "input_path": str(payload.get("input_path") or _path),
                        "variant_mode": str(payload.get("variant_mode") or "path_sensitive_mflac"),
                        "variant_label": str(payload.get("variant_label") or "路径敏感型 mflac 变体"),
                        "message": str(payload.get("message") or f"正在执行变体转换：{str(payload.get('variant_label') or '路径敏感型 mflac 变体')}"),
                    },
                )
            decrypt_started = time.perf_counter()
            detail = adapter.decrypt_one(file_path, work_dir, decrypt_settings, log_dir=log_dir)
            file_timing["decrypt_sec"] = round(time.perf_counter() - decrypt_started, 6)
            decrypt_detail_timing = _artifact_timing(detail)
            _log_decrypt_detail(logger, config.platform_id, index, len(files), file_path.name, detail, decrypt_detail_timing)

            working_path = pathlib.Path(str(detail["output_path"]))
            if _is_stop_requested(config):
                stopped_early = True
                logger.info("stop_requested_after_decrypt: %s", file_path.name)
                _cleanup_working_path(working_path)
                break

            detected_container = str(detail.get("detected_container") or detail.get("final_extension") or "bin").lower()
            decrypt_summary = _log_media_summary(logger, "Decrypt media summary", working_path)
            summary_error = _validate_summary(logger, "Decrypt", working_path, decrypt_summary)
            if summary_error:
                raise RuntimeError(str(detail.get("reason") or summary_error))

            normalized_target = _normalize_final_target(
                desired_target, detected_container, transcode_enabled=transcode_enabled_setting,
            )
            prepared_artifacts.append(_PreparedArtifact(
                index=index, total_count=len(files), input_path=file_path,
                basename=basename, desired_target=normalized_target,
                file_started=file_started, working_path=working_path,
                detected_container=detected_container, detail=detail,
                decrypt_detail_timing=decrypt_detail_timing, file_timing=file_timing,
            ))
            logger.info("decoded_ready: %s container=%s target=%s needs_transcode=%s",
                        file_path.name, detected_container, normalized_target,
                        _artifact_needs_transcode(normalized_target, detected_container))
            _emit_event(config, "file_decrypted", {
                "platform_id": config.platform_id, "index": index, "total": len(files),
                "input_path": str(file_path), "working_path": str(working_path),
                "detected_container": detected_container, "desired_target": normalized_target,
                "needs_transcode": _artifact_needs_transcode(normalized_target, detected_container),
                "timing": dict(file_timing), "decrypt_detail_timing": dict(decrypt_detail_timing),
                "payload": dict(detail),
            })
        except Exception as exc:
            _cleanup_working_path(working_path)
            file_timing["total_sec"] = round(time.perf_counter() - file_started, 6)
            _accumulate(timing_batch_total, file_timing)
            logger.warning("failed: %s reason=%s", file_path.name, exc)
            logger.info("[timing] file_done [%d/%d] %s reason=%s %s",
                        index, len(files), file_path.name, exc, timing_text(file_timing))
            result = FileResult(ok=False, skipped=False, platform_id=config.platform_id,
                               input_path=str(file_path), reason=str(exc),
                               timing=_copy_timing(file_timing))
            results.append(result)
            _emit_event(config, "file_finished", {
                "platform_id": config.platform_id, "index": index, "total": len(files),
                "result": "failed", "input_path": str(file_path), "reason": str(exc),
                "timing": dict(result.timing),
            })
            failed_count += 1

    should_transcode = False
    if prepared_artifacts:
        should_transcode, pending_transcode = _resolve_batch_transcode_choice(
            logger, config, prepared_artifacts,
            failed_count=failed_count, stopped_early=stopped_early,
        )
        if should_transcode and pending_transcode:
            logger.info("batch_transcode_started: pending=%d", len(pending_transcode))
            _emit_event(config, "batch_transcode_started", {
                "platform_id": config.platform_id, "pending_count": len(pending_transcode),
                "pending_files": [item.input_path.name for item in pending_transcode],
            })

    finalized_count = 0
    for prepared in prepared_artifacts:
        status, result = _finalize_prepared_artifact(
            logger, config, cover_service, manifest_repo, prepared,
            should_transcode=should_transcode,
            transcode_sample_rate_hz=transcode_sample_rate_hz,
            transcode_bitrate_kbps=transcode_bitrate_kbps,
            file_started=prepared.file_started,
        )
        finalized_count += 1
        results.append(result)
        _accumulate(timing_batch_total, result.timing)
        if status == "success":
            success_count += 1
        elif status == "already_decrypted":
            skipped_count += 1
        elif result.reason == "stopped_by_user":
            stopped_early = True
            break
        else:
            failed_count += 1
        if _is_stop_requested(config):
            stopped_early = True
            break

    if finalized_count < len(prepared_artifacts):
        for leftover in prepared_artifacts[finalized_count:]:
            _cleanup_working_path(leftover.working_path)

    timed_file_count = len(results) if results else 1
    timing_batch_avg = {key: round(float(timing_batch_total.get(key, 0.0)) / float(timed_file_count), 6) for key in TIMING_STAGE_KEYS}
    hotspot_candidates = {key: value for key, value in timing_batch_total.items() if key != "total_sec"}
    hotspot_stage = max(hotspot_candidates, key=hotspot_candidates.get) if hotspot_candidates else None
    timing_hotspot_stage = {
        "stage": hotspot_stage,
        "total_sec": round(float(hotspot_candidates.get(hotspot_stage, 0.0)), 6) if hotspot_stage else 0.0,
        "ratio_of_total": round(float(hotspot_candidates.get(hotspot_stage, 0.0)) / float(timing_batch_total.get("total_sec", 0.0)), 6) if hotspot_stage and float(timing_batch_total.get("total_sec", 0.0)) > 0.0 else 0.0,
        "batch_wall_sec": round(time.perf_counter() - batch_started, 6),
    }
    result_code = 3 if stopped_early else (0 if failed_count == 0 else 2)
    summary = BatchSummary(
        result_code=result_code, platform_id=config.platform_id,
        input_path=str(config.input_path), output_dir=str(config.output_dir),
        success_count=success_count, skipped_count=skipped_count, failed_count=failed_count,
        candidate_count=len(files), timing_batch_total=timing_batch_total,
        timing_batch_avg=timing_batch_avg, timing_hotspot_stage=timing_hotspot_stage,
    )
    batch_json, batch_txt = write_batch_reports(log_dir, config.platform_id, results, summary)
    logger.info("[timing] batch_total: %s", timing_text(timing_batch_total))
    logger.info("[timing] batch_avg: %s", timing_text(timing_batch_avg))
    logger.info("[timing] batch_hotspot: stage=%s total_sec=%.3fs ratio=%.2f%% wall=%.3fs",
                timing_hotspot_stage.get("stage"), float(timing_hotspot_stage.get("total_sec", 0.0)),
                float(timing_hotspot_stage.get("ratio_of_total", 0.0)) * 100.0,
                float(timing_hotspot_stage.get("batch_wall_sec", 0.0)))
    logger.info("batch_result_code=%s", result_code)
    logger.info("batch_report_json=%s", batch_json)
    logger.info("batch_report_txt=%s", batch_txt)
    _emit_event(config, "batch_finished", {
        "platform_id": config.platform_id, "result_code": result_code,
        "success_count": success_count, "skipped_count": skipped_count,
        "failed_count": failed_count, "candidate_count": len(files),
        "timing_batch_total": dict(timing_batch_total), "timing_batch_avg": dict(timing_batch_avg),
        "timing_hotspot_stage": dict(timing_hotspot_stage),
        "batch_report_json": str(batch_json), "batch_report_txt": str(batch_txt),
    })
    try:
        shutil.rmtree(work_dir, ignore_errors=True)
    except Exception:
        pass
    return result_code


__all__ = [
    "AUDIO_OUTPUT_EXTS", "run_batch",
    "_PreparedArtifact", "_new_timing", "_copy_timing", "_accumulate",
    "_artifact_timing", "_throughput_mib", "_log_decrypt_detail",
    "_emit_event", "_is_stop_requested", "_cleanup_working_path",
    "_transcode_enabled", "_transcode_audio_profile",
    "_log_media_summary", "_validate_summary", "_artifact_needs_transcode",
    "_normalize_final_target", "_resolve_publish_target",
    "_finalize_prepared_artifact", "_resolve_batch_transcode_choice",
]
