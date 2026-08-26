"""Config path auto-discovery helpers.

Extracted from config_repository.py for cohesion — all the "find X path"
logic lives here, independent from config loading/saving.
"""
from __future__ import annotations

import pathlib
from typing import Any

from src.Infrastructure.runtime_paths import RuntimePaths, appdata_path


# ---------------------------------------------------------------------------
# Kugou key
# ---------------------------------------------------------------------------

def iter_kugou_key_candidates(paths: RuntimePaths) -> list[pathlib.Path]:
    candidates = [
        paths.root_dir / "assets" / "kugou_key_refreshed.xz",
        paths.assets_dir / "kugou_key.xz",
        paths.root_dir / "assets" / "kugou_key.xz",
        paths.bundle_dir / "assets" / "kugou_key.xz",
        paths.bundle_dir / "assets" / "kugou_key_refreshed.xz",
        pathlib.Path.cwd() / "assets" / "kugou_key.xz",
        pathlib.Path.cwd() / "assets" / "kugou_key_refreshed.xz",
        pathlib.Path.cwd() / "kugou_key.xz",
    ]
    unique: list[pathlib.Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        lowered = str(candidate).lower()
        if lowered in seen:
            continue
        seen.add(lowered)
        unique.append(candidate)
    return unique


def auto_find_kugou_key(paths: RuntimePaths) -> pathlib.Path | None:
    for candidate in iter_kugou_key_candidates(paths):
        if candidate.exists() and candidate.is_file():
            return candidate
    return None


# ---------------------------------------------------------------------------
# KGG database
# ---------------------------------------------------------------------------

def iter_kgg_db_candidates() -> list[pathlib.Path]:
    candidates: list[pathlib.Path] = []
    appdata = appdata_path()
    if appdata is not None:
        candidates.append(appdata / "KuGou8" / "KGMusicV3.db")
        candidates.extend(sorted(appdata.glob("KuGou*\\KGMusicV3.db")))
    unique: list[pathlib.Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        lowered = str(candidate).lower()
        if lowered in seen:
            continue
        seen.add(lowered)
        unique.append(candidate)
    return unique


def auto_find_kgg_db_path() -> pathlib.Path | None:
    for candidate in iter_kgg_db_candidates():
        if candidate.exists() and candidate.is_file():
            return candidate
    return None


# ---------------------------------------------------------------------------
# Kuwo signature
# ---------------------------------------------------------------------------

def default_kuwo_signature_path(paths: RuntimePaths) -> pathlib.Path:
    candidates = [
        paths.bundle_dir / "src" / "Infrastructure" / "platforms" / "kuwo" / "runtime_m" / "out" / "recovered_signature.json",
        paths.bundle_dir / "src" / "Infrastructure" / "platforms" / "kuwo" / "runtime_m" / "out" / "out" / "recovered_signature.json",
        paths.root_dir / "src" / "Infrastructure" / "platforms" / "kuwo" / "runtime_m" / "out" / "recovered_signature.json",
        paths.root_dir / "src" / "Infrastructure" / "platforms" / "kuwo" / "runtime_m" / "out" / "out" / "recovered_signature.json",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return candidates[0]


# ---------------------------------------------------------------------------
# Config value normalizers
# ---------------------------------------------------------------------------

def _normalize_optional_config_int(value: Any) -> int | None:
    if value in (None, '', False):
        return None
    try:
        normalized = int(value)
    except Exception:
        return None
    return normalized if normalized > 0 else None


def _normalize_optional_audio_choice(value: Any, allowed: tuple[int, ...]) -> int | None:
    normalized = _normalize_optional_config_int(value)
    if normalized is None:
        return None
    return normalized if normalized in allowed else None
