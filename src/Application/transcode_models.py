"""Data models and normalize helpers for transcode batch service.

This module holds pure data classes and stateless helpers that previously
lived inside transcode_batch_service.py but are now isolated for cohesion.
"""
from __future__ import annotations

from dataclasses import dataclass
import pathlib
from typing import Any, Iterable


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

ALL_SOURCE_FORMAT = "全部"
TRANSCODE_SOURCE_FORMATS: tuple[str, ...] = (
    ALL_SOURCE_FORMAT,
    "flac",
    "m4a",
    "mp3",
    "wav",
    "ogg",
    "aac",
    "ape",
)
TRANSCODE_TARGET_FORMATS: tuple[str, ...] = ("flac", "m4a", "mp3", "wav")
TRANSCODE_SAMPLE_RATE_OPTIONS: tuple[int, ...] = (22050, 32000, 44100, 48000, 88200, 96000)
TRANSCODE_BITRATE_OPTIONS: tuple[int, ...] = (96, 128, 160, 192, 256, 320)
SUPPORTED_INPUT_EXTENSIONS = {item for item in TRANSCODE_SOURCE_FORMATS if item != ALL_SOURCE_FORMAT}


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass(slots=True)
class TranscodeRule:
    source_format: str
    target_format: str
    sample_rate_hz: int | None = None
    bitrate_kbps: int | None = None


@dataclass(slots=True)
class TranscodeJob:
    source_root: pathlib.Path
    input_path: pathlib.Path
    relative_path: pathlib.Path
    target_format: str
    output_path: pathlib.Path
    sample_rate_hz: int | None = None
    bitrate_kbps: int | None = None

    @property
    def source_format(self) -> str:
        return self.input_path.suffix.lower().lstrip(".")


@dataclass(slots=True)
class TranscodeBatchResult:
    total_jobs: int
    success_count: int
    failed_count: int
    skipped_count: int
    results: list[dict[str, Any]]
    elapsed_sec: float


# ---------------------------------------------------------------------------
# Normalize helpers
# ---------------------------------------------------------------------------

def normalize_source_format(value: str) -> str:
    raw = str(value or ALL_SOURCE_FORMAT).strip().lower().lstrip(".")
    if raw in {"all", ALL_SOURCE_FORMAT.lower()}:
        return ALL_SOURCE_FORMAT
    if raw not in SUPPORTED_INPUT_EXTENSIONS:
        raise ValueError(f"unsupported source format: {value}")
    return raw


def normalize_target_format(value: str) -> str:
    raw = str(value or "m4a").strip().lower().lstrip(".")
    if raw not in TRANSCODE_TARGET_FORMATS:
        raise ValueError(f"unsupported target format: {value}")
    return raw


def _normalize_optional_int(
    value: Any,
    *,
    label: str,
    allowed: tuple[int, ...],
) -> int | None:
    if value in (None, "", False):
        return None
    try:
        normalized = int(value)
    except Exception as exc:
        raise ValueError(f"invalid {label}: {value}") from exc
    if normalized <= 0:
        return None
    if normalized not in allowed:
        allowed_text = ", ".join(str(item) for item in allowed)
        raise ValueError(f"unsupported {label}: {value}; allowed={allowed_text}")
    return normalized


def normalize_sample_rate(value: Any) -> int | None:
    return _normalize_optional_int(value, label="sample rate", allowed=TRANSCODE_SAMPLE_RATE_OPTIONS)


def normalize_bitrate(value: Any) -> int | None:
    return _normalize_optional_int(value, label="bitrate", allowed=TRANSCODE_BITRATE_OPTIONS)


def normalize_rules(items: Iterable[dict[str, Any] | TranscodeRule]) -> list[TranscodeRule]:
    rules: list[TranscodeRule] = []
    for item in items:
        if isinstance(item, TranscodeRule):
            source_format = normalize_source_format(item.source_format)
            target_format = normalize_target_format(item.target_format)
            sample_rate_hz = normalize_sample_rate(item.sample_rate_hz)
            bitrate_kbps = normalize_bitrate(item.bitrate_kbps)
        else:
            source_format = normalize_source_format(str(item.get("source_format", ALL_SOURCE_FORMAT)))
            target_format = normalize_target_format(str(item.get("target_format", "m4a")))
            sample_rate_hz = normalize_sample_rate(item.get("sample_rate_hz"))
            bitrate_kbps = normalize_bitrate(item.get("bitrate_kbps"))
        rules.append(
            TranscodeRule(
                source_format=source_format,
                target_format=target_format,
                sample_rate_hz=sample_rate_hz,
                bitrate_kbps=bitrate_kbps,
            )
        )
    if not rules:
        rules.append(TranscodeRule(source_format=ALL_SOURCE_FORMAT, target_format="m4a"))
    return rules


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _iter_input_files(root: pathlib.Path, recursive: bool) -> list[pathlib.Path]:
    if root.is_file():
        return [root]
    if recursive:
        return [path for path in root.rglob("*") if path.is_file()]
    return [path for path in root.iterdir() if path.is_file()]


def _output_base_name(input_root: pathlib.Path) -> str:
    if input_root.is_dir():
        return input_root.name or "input"
    return input_root.stem or "input"


def _rule_profile_suffix(rule: TranscodeRule) -> str:
    parts: list[str] = []
    if rule.sample_rate_hz:
        parts.append(f"{rule.sample_rate_hz}hz")
    if rule.bitrate_kbps:
        parts.append(f"{rule.bitrate_kbps}k")
    return ("." + ".".join(parts)) if parts else ""
