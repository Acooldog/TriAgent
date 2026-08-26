"""Application.models — re-export shim for backward compatibility.

All pure data classes, type aliases and Protocol interfaces now live in
``src.Domain.models`` (the hexagonal inner layer). This module exists
so legacy imports like ``from src.Application.models import BatchRunConfig``
continue to work without modification.
"""
from __future__ import annotations

from src.Domain.models import *  # noqa: F401,F403
from src.Domain.models import (  # noqa: F401  explicit __all__ anchor
    ALL_SOURCE_FORMAT,
    BatchRunConfig,
    BatchSummary,
    FileResult,
    PlatformAdapter,
    RunEventSink,
    StopRequested,
    SUPPORTED_INPUT_EXTENSIONS,
    TIMING_STAGE_KEYS,
    TRANSCODE_SOURCE_FORMATS,
    TRANSCODE_TARGET_FORMATS,
    TranscodeBatchResult,
    TranscodeConfirmationResolver,
    TranscodeJob,
    TranscodeRule,
    normalize_bitrate,
    normalize_rules,
    normalize_sample_rate,
    normalize_source_format,
    normalize_target_format,
)


__all__ = [
    "ALL_SOURCE_FORMAT",
    "BatchRunConfig",
    "BatchSummary",
    "FileResult",
    "PlatformAdapter",
    "RunEventSink",
    "StopRequested",
    "SUPPORTED_INPUT_EXTENSIONS",
    "TIMING_STAGE_KEYS",
    "TRANSCODE_SOURCE_FORMATS",
    "TRANSCODE_TARGET_FORMATS",
    "TranscodeBatchResult",
    "TranscodeConfirmationResolver",
    "TranscodeJob",
    "TranscodeRule",
    "normalize_bitrate",
    "normalize_rules",
    "normalize_sample_rate",
    "normalize_source_format",
    "normalize_target_format",
]
