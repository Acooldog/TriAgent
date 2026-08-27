"""Application.transcode_models — re-export shim for backward compatibility.

All transcode-related data classes and normalize helpers now live in
``src.Domain.models`` (the hexagonal inner layer). This module exists
so legacy imports like ``from src.Application.transcode.transcode_models import TranscodeJob``
continue to work.
"""
from __future__ import annotations

from src.Domain.models import *  # noqa: F401,F403
from src.Domain.models import (  # noqa: F401  explicit anchors
    ALL_SOURCE_FORMAT,
    SUPPORTED_INPUT_EXTENSIONS,
    TRANSCODE_SOURCE_FORMATS,
    TRANSCODE_TARGET_FORMATS,
    TranscodeBatchResult,
    TranscodeJob,
    TranscodeRule,
    _iter_input_files,
    _output_base_name,
    _rule_profile_suffix,
    normalize_bitrate,
    normalize_rules,
    normalize_sample_rate,
    normalize_source_format,
    normalize_target_format,
)
from src.Domain.constants import (
    TRANSCODE_BITRATE_OPTIONS,
    TRANSCODE_SAMPLE_RATE_OPTIONS,
)


__all__ = [
    "ALL_SOURCE_FORMAT",
    "TRANSCODE_SOURCE_FORMATS",
    "TRANSCODE_TARGET_FORMATS",
    "TRANSCODE_SAMPLE_RATE_OPTIONS",
    "TRANSCODE_BITRATE_OPTIONS",
    "SUPPORTED_INPUT_EXTENSIONS",
    "TranscodeRule",
    "TranscodeJob",
    "TranscodeBatchResult",
    "normalize_source_format",
    "normalize_target_format",
    "normalize_sample_rate",
    "normalize_bitrate",
    "normalize_rules",
]
