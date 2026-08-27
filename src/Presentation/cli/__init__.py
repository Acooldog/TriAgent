from __future__ import annotations

from src.Presentation.cli.cli import main
from src.Presentation.cli.cli_prompts import (
    PLATFORM_LABELS,
    build_transcode_confirmation_resolver,
    choose_platform,
    collision_prompt,
    is_running_as_admin,
    pause_exit,
    prompt_bool,
    prompt_choice,
    prompt_with_default,
)
from src.Presentation.cli.cli_run import (
    _ensure_running_for_interactive,
    _require_admin,
    _run_platform,
    _shared_recursive,
    _validate_kugou_runtime,
    run_interactive,
)

__all__ = [
    "main",
    "PLATFORM_LABELS",
    "build_transcode_confirmation_resolver",
    "choose_platform",
    "collision_prompt",
    "is_running_as_admin",
    "pause_exit",
    "prompt_bool",
    "prompt_choice",
    "prompt_with_default",
    "_ensure_running_for_interactive",
    "_require_admin",
    "_run_platform",
    "_shared_recursive",
    "_validate_kugou_runtime",
    "run_interactive",
]
