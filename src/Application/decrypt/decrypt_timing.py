from __future__ import annotations

import logging
from typing import Any

from src.Application.models import TIMING_STAGE_KEYS


def _new_timing() -> dict[str, float]:
    return {key: 0.0 for key in TIMING_STAGE_KEYS}


def _copy_timing(source: dict[str, float]) -> dict[str, float]:
    return {key: round(float(source.get(key, 0.0)), 6) for key in TIMING_STAGE_KEYS}


def _accumulate(total: dict[str, float], single: dict[str, float]) -> None:
    for key in TIMING_STAGE_KEYS:
        total[key] = round(float(total.get(key, 0.0)) + float(single.get(key, 0.0)), 6)


def _artifact_timing(detail: dict[str, Any]) -> dict[str, float]:
    timing = detail.get("timing") or detail.get("decrypt_detail_timing") or {}
    if timing:
        return {k: float(v) for k, v in timing.items() if isinstance(v, (int, float))}
    total = float(detail.get("elapsed_sec", 0.0))
    return {
        "header_parse_sec": 0.0,
        "key_material_sec": 0.0,
        "stream_decode_sec": total,
        "publish_sec": 0.0,
        "total_sec": total,
    }


def _throughput_mib(detail: dict[str, Any], decrypt_timing: dict[str, float]) -> float:
    decoded_bytes = int(detail.get("decoded_bytes", 0) or 0)
    stream_decode = float(decrypt_timing.get("stream_decode_sec", 0.0))
    if decoded_bytes <= 0 or stream_decode <= 0.0:
        return 0.0
    return decoded_bytes / (1024.0 * 1024.0) / stream_decode


def _log_decrypt_detail(logger: logging.Logger, platform_id: str, index: int, total_count: int, file_name: str, detail: dict[str, Any], decrypt_timing: dict[str, float]) -> None:
    logger.info(
        "[timing] decrypt_detail [%d/%d] %s platform=%s backend=%s header_parse=%.3fs key_material=%.3fs stream_decode=%.3fs publish=%.3fs total=%.3fs decoded_bytes=%d throughput=%.2fMiB/s",
        index,
        total_count,
        file_name,
        platform_id,
        detail.get("backend", "unknown"),
        float(decrypt_timing.get("header_parse_sec", 0.0)),
        float(decrypt_timing.get("key_material_sec", 0.0)),
        float(decrypt_timing.get("stream_decode_sec", 0.0)),
        float(decrypt_timing.get("publish_sec", 0.0)),
        float(decrypt_timing.get("total_sec", 0.0)),
        int(detail.get("decoded_bytes", 0) or 0),
        _throughput_mib(detail, decrypt_timing),
    )


__all__ = [
    "_new_timing",
    "_copy_timing",
    "_accumulate",
    "_artifact_timing",
    "_throughput_mib",
    "_log_decrypt_detail",
]
