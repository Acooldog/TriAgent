from __future__ import annotations

import pathlib
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Protocol


# ---------------------------------------------------------------------------
# Constants (timing & transcode-related)
# ---------------------------------------------------------------------------

TIMING_STAGE_KEYS = ("scan_sec", "dedupe_sec", "decrypt_sec", "transcode_sec", "publish_sec", "total_sec")
RunEventSink = Callable[[str, dict[str, Any]], None]
StopRequested = Callable[[], bool]
TranscodeConfirmationResolver = Callable[[dict[str, Any]], tuple[bool, bool] | None]

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


# ---------------------------------------------------------------------------
# PlatformPort Protocol (kept as PlatformAdapter for backward compat)
# ---------------------------------------------------------------------------

class PlatformAdapter(Protocol):
    """Protocol for platform-specific decryption adapters.

    This Protocol is intentionally named ``PlatformAdapter`` so that existing
    imports like ``from src.Application.models import PlatformAdapter`` keep
    working after the Application layer becomes a re-export shim.
    """

    platform_id: str
    display_name: str

    def requires_running_process(self) -> bool: ...
    def validate_runtime(self, settings: dict[str, Any]) -> tuple[bool, str | None]: ...
    def collect_files(self, input_path: pathlib.Path, recursive: bool) -> list[pathlib.Path]: ...
    def output_basename(self, input_path: pathlib.Path) -> str: ...
    def predicted_extension(self, input_path: pathlib.Path, settings: dict[str, Any]) -> str | None: ...
    def desired_target_format(self, input_path: pathlib.Path, settings: dict[str, Any]) -> str: ...
    def decrypt_one(self, input_path: pathlib.Path, work_dir: pathlib.Path, settings: dict[str, Any], *, log_dir: pathlib.Path) -> dict[str, Any]: ...


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass(slots=True)
class BatchRunConfig:
    platform_id: str
    input_path: pathlib.Path
    output_dir: pathlib.Path
    recursive: bool
    collision_policy: str
    settings: dict[str, Any]
    interactive: bool = False
    collision_resolver: Callable[[str, str, str | None], str] | None = None
    event_sink: RunEventSink | None = None
    stop_requested: StopRequested | None = None
    transcode_confirmation_resolver: TranscodeConfirmationResolver | None = None


@dataclass(slots=True)
class FileResult:
    ok: bool
    platform_id: str
    input_path: str
    output_path: str | None = None
    reason: str | None = None
    skipped: bool = False
    timing: dict[str, float] = field(default_factory=dict)
    decrypt_detail_timing: dict[str, float] = field(default_factory=dict)
    payload: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class BatchSummary:
    result_code: int
    platform_id: str
    input_path: str
    output_dir: str
    success_count: int
    skipped_count: int
    failed_count: int
    candidate_count: int
    timing_batch_total: dict[str, float]
    timing_batch_avg: dict[str, float]
    timing_hotspot_stage: dict[str, float | str | None]


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


SUPPORTED_INPUT_EXTENSIONS = {item for item in TRANSCODE_SOURCE_FORMATS if item != ALL_SOURCE_FORMAT}


# ---------------------------------------------------------------------------
# Normalize helpers (pure)
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
    from src.Domain.constants import TRANSCODE_SAMPLE_RATE_OPTIONS as _SAMPLE_RATE_OPTIONS
    return _normalize_optional_int(value, label="sample rate", allowed=_SAMPLE_RATE_OPTIONS)


def normalize_bitrate(value: Any) -> int | None:
    from src.Domain.constants import TRANSCODE_BITRATE_OPTIONS as _BITRATE_OPTIONS
    return _normalize_optional_int(value, label="bitrate", allowed=_BITRATE_OPTIONS)


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
# Internal helpers (kept as public for re-export compatibility)
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


__all__ = [
    "TIMING_STAGE_KEYS",
    "RunEventSink",
    "StopRequested",
    "TranscodeConfirmationResolver",
    "ALL_SOURCE_FORMAT",
    "TRANSCODE_SOURCE_FORMATS",
    "TRANSCODE_TARGET_FORMATS",
    "SUPPORTED_INPUT_EXTENSIONS",
    "PlatformAdapter",
    "BatchRunConfig",
    "FileResult",
    "BatchSummary",
    "TranscodeRule",
    "TranscodeJob",
    "TranscodeBatchResult",
    "normalize_source_format",
    "normalize_target_format",
    "normalize_sample_rate",
    "normalize_bitrate",
    "normalize_rules",
    "_iter_input_files",
    "_output_base_name",
    "_rule_profile_suffix",
]
