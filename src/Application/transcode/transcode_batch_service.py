"""Transcode batch service — core job planning and parallel execution.

Data classes and normalize helpers have been extracted to ``transcode_models``
(now a re-export shim pointing at ``src.Domain.models``). This module stays
focused on orchestration: build jobs from rules and input paths, and run
them in parallel via ThreadPoolExecutor.

Infrastructure dependency (ffmpeg transcode) is injected via the ``ports``
argument, which must provide a ``transcode: TranscodePort`` attribute.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
import pathlib
import threading
import time
from typing import Any, Callable, Iterable

from src.Domain.ports import TranscodePort
from src.Application.transcode.transcode_models import (
    ALL_SOURCE_FORMAT,
    SUPPORTED_INPUT_EXTENSIONS,
    TranscodeBatchResult,
    TranscodeJob,
    TranscodeRule,
    _iter_input_files,
    _output_base_name,
    _rule_profile_suffix,
    normalize_rules,
)


# Re-export public API so callers can keep importing from this module.
__all__ = [
    "ALL_SOURCE_FORMAT",
    "TRANSCODE_SOURCE_FORMATS",
    "TRANSCODE_TARGET_FORMATS",
    "TRANSCODE_SAMPLE_RATE_OPTIONS",
    "TRANSCODE_BITRATE_OPTIONS",
    "SUPPORTED_INPUT_EXTENSIONS",
    "EventSink",
    "TranscodeRule",
    "TranscodeJob",
    "TranscodeBatchResult",
    "normalize_source_format",
    "normalize_target_format",
    "normalize_sample_rate",
    "normalize_bitrate",
    "normalize_rules",
    "build_transcode_jobs",
    "run_transcode_batch",
]

# Re-export the constants and normalize fns from transcode_models (Domain shim).
from src.Application.transcode.transcode_models import (  # noqa: E402,F401
    TRANSCODE_SOURCE_FORMATS,
    TRANSCODE_TARGET_FORMATS,
    TRANSCODE_SAMPLE_RATE_OPTIONS,
    TRANSCODE_BITRATE_OPTIONS,
    normalize_source_format,
    normalize_target_format,
    normalize_sample_rate,
    normalize_bitrate,
)


EventSink = Callable[[str, dict[str, Any]], None]


# ---------------------------------------------------------------------------
# Job planning
# ---------------------------------------------------------------------------

def build_transcode_jobs(
    input_paths: Iterable[pathlib.Path],
    output_dir: pathlib.Path,
    rules: Iterable[dict[str, Any] | TranscodeRule],
    *,
    recursive: bool = True,
) -> tuple[list[TranscodeJob], list[str]]:
    normalized_rules = normalize_rules(rules)
    jobs: list[TranscodeJob] = []
    warnings: list[str] = []
    seen: set[tuple[str, str, int | None, int | None]] = set()
    output_dir = output_dir.resolve()

    for raw_root in input_paths:
        source_root = pathlib.Path(raw_root).expanduser()
        if not source_root.exists():
            warnings.append(f"输入路径不存在：{source_root}")
            continue
        files = _iter_input_files(source_root, recursive)
        if not files:
            warnings.append(f"输入路径下没有文件：{source_root}")
            continue
        root_name = _output_base_name(source_root)
        for file_path in files:
            source_format = file_path.suffix.lower().lstrip(".")
            if source_format not in SUPPORTED_INPUT_EXTENSIONS:
                continue
            matching_rules: list[TranscodeRule] = []
            for rule in normalized_rules:
                if rule.source_format == ALL_SOURCE_FORMAT or rule.source_format == source_format:
                    matching_rules.append(rule)
            if not matching_rules:
                continue
            relative_path = pathlib.Path(file_path.name)
            if source_root.is_dir():
                relative_path = file_path.relative_to(source_root)
            for rule in matching_rules:
                key = (str(file_path).lower(), rule.target_format, rule.sample_rate_hz, rule.bitrate_kbps)
                if key in seen:
                    continue
                seen.add(key)
                suffix = _rule_profile_suffix(rule)
                output_path = output_dir / root_name / relative_path.parent / f"{file_path.stem}{suffix}.{rule.target_format}"
                jobs.append(
                    TranscodeJob(
                        source_root=source_root,
                        input_path=file_path,
                        relative_path=relative_path,
                        target_format=rule.target_format,
                        output_path=output_path,
                        sample_rate_hz=rule.sample_rate_hz,
                        bitrate_kbps=rule.bitrate_kbps,
                    )
                )
    return jobs, warnings


# ---------------------------------------------------------------------------
# Batch execution — infrastructure (transcode_file) injected via ports
# ---------------------------------------------------------------------------

def run_transcode_batch(
    input_paths: Iterable[pathlib.Path],
    output_dir: pathlib.Path,
    rules: Iterable[dict[str, Any] | TranscodeRule],
    *,
    recursive: bool = True,
    max_workers: int = 2,
    event_sink: EventSink | None = None,
    transcode_port: TranscodePort | None = None,
) -> TranscodeBatchResult:
    """Run a transcode batch.

    Args:
        transcode_port: Infrastructure adapter providing ``transcode_file``.
            When ``None`` the function falls back to
            ``Infrastructure.transcoder.transcode_file`` for backward compat.
    """
    # Lazy import preserves the old default behaviour when callers do not
    # provide a port; new callers (Presentation layer) should always inject one.
    if transcode_port is None:
        from src.Infrastructure.adapters.media.transcode.transcoder import transcode_file as _transcode_file  # type: ignore[no-redef]
    else:
        _transcode_file = transcode_port.transcode_file  # type: ignore[assignment]

    started = time.perf_counter()
    jobs, warnings = build_transcode_jobs(input_paths, output_dir, rules, recursive=recursive)
    sink = event_sink or (lambda _event, _payload: None)
    sink(
        "plan_ready",
        {
            "total_jobs": len(jobs),
            "warnings": list(warnings),
            "output_dir": str(pathlib.Path(output_dir)),
            "worker_count": max(1, min(int(max_workers or 1), 4)),
        },
    )
    for warning in warnings:
        sink("warning", {"message": warning})
    if not jobs:
        elapsed_sec = time.perf_counter() - started
        sink(
            "batch_finished",
            {
                "total_jobs": 0,
                "success_count": 0,
                "failed_count": 0,
                "skipped_count": 0,
                "elapsed_sec": round(elapsed_sec, 3),
            },
        )
        return TranscodeBatchResult(
            total_jobs=0,
            success_count=0,
            failed_count=0,
            skipped_count=0,
            results=[],
            elapsed_sec=elapsed_sec,
        )

    worker_count = max(1, min(int(max_workers or 1), 4))
    queued = len(jobs)
    running = 0
    completed = 0
    lock = threading.Lock()
    results: list[dict[str, Any]] = []

    def _run_job(job: TranscodeJob) -> dict[str, Any]:
        nonlocal queued, running, completed
        with lock:
            queued -= 1
            running += 1
            sink(
                "job_started",
                {
                    "input_path": str(job.input_path),
                    "output_path": str(job.output_path),
                    "target_format": job.target_format,
                    "sample_rate_hz": job.sample_rate_hz,
                    "bitrate_kbps": job.bitrate_kbps,
                    "queued": queued,
                    "running": running,
                    "completed": completed,
                },
            )
        job_started = time.perf_counter()
        try:
            _transcode_file(
                job.input_path,
                job.output_path,
                job.target_format,
                sample_rate_hz=job.sample_rate_hz,
                bitrate_kbps=job.bitrate_kbps,
            )
            elapsed = time.perf_counter() - job_started
            result = {
                "ok": True,
                "input_path": str(job.input_path),
                "output_path": str(job.output_path),
                "target_format": job.target_format,
                "sample_rate_hz": job.sample_rate_hz,
                "bitrate_kbps": job.bitrate_kbps,
                "elapsed_sec": round(elapsed, 3),
            }
            sink("job_succeeded", result)
            return result
        except Exception as exc:
            elapsed = time.perf_counter() - job_started
            result = {
                "ok": False,
                "input_path": str(job.input_path),
                "output_path": str(job.output_path),
                "target_format": job.target_format,
                "sample_rate_hz": job.sample_rate_hz,
                "bitrate_kbps": job.bitrate_kbps,
                "elapsed_sec": round(elapsed, 3),
                "reason": str(exc),
            }
            sink("job_failed", result)
            return result
        finally:
            with lock:
                running -= 1
                completed += 1
                sink(
                    "queue_progress",
                    {
                        "queued": queued,
                        "running": running,
                        "completed": completed,
                        "total_jobs": len(jobs),
                    },
                )

    with ThreadPoolExecutor(max_workers=worker_count, thread_name_prefix="transcode") as executor:
        futures = [executor.submit(_run_job, job) for job in jobs]
        for future in as_completed(futures):
            results.append(future.result())

    success_count = sum(1 for item in results if item.get("ok"))
    failed_count = sum(1 for item in results if not item.get("ok"))
    elapsed_sec = time.perf_counter() - started
    sink(
        "batch_finished",
        {
            "total_jobs": len(jobs),
            "success_count": success_count,
            "failed_count": failed_count,
            "elapsed_sec": round(elapsed_sec, 3),
        },
    )
    return TranscodeBatchResult(
        total_jobs=len(jobs),
        success_count=success_count,
        failed_count=failed_count,
        skipped_count=0,
        results=results,
        elapsed_sec=elapsed_sec,
    )
