from __future__ import annotations
import json
import logging
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

logger = logging.getLogger("qkkdecrypt.infrastructure.qq_internal_direct")

QUALITY_SUFFIX_RE = re.compile(r"_[A-Za-z0-9]{1,8}(?:\(\d+\))?$")
CACHE_DIR = Path(r"K:\QQMusicCache\QMDL")
PICTURE_DIR = Path(r"K:\QQMusicCache\QQMusicPicture")
ACTIVE_ARG0_HEX = "582f83260300000000000000a40f8979a40f897901000000020000000500000014d46600e81c7723020000000000000001000000e27c3700e3000000ffffffff"
ACTIVE_ARG1_HEX = "802c8326e0a9811d00000000a40f897901000000c09cf80915d93301cada330172d93301000000002067a61400000000a40f8979c88095c2262700907818e67b"

def _detect_container_fast(path: Path) -> str:
    try:
        head = path.read_bytes()[:16]
    except OSError:
        return "bin"
    if head.startswith(b"fLaC"):
        return "flac"
    if head.startswith(b"OggS"):
        return "ogg"
    if len(head) >= 12 and head[4:8] == b"ftyp":
        return "m4a"
    if head.startswith(b"RIFF") and len(head) >= 12 and head[8:12] == b"WAVE":
        return "wav"
    if head.startswith(b"ID3") or (len(head) >= 2 and head[0] == 0xFF and (head[1] & 0xE0) == 0xE0):
        return "mp3"
    return "bin"

def _find_qqmusic_pid() -> int | None:
    for line in os.popen('tasklist /FI "IMAGENAME eq QQMusic.exe" /FO CSV /NH').read().splitlines():
        if "QQMusic.exe" not in line:
            continue
        parts = [p.strip('"') for p in line.split(",")]
        if len(parts) > 1:
            return int(parts[1])
    return None

def _normalize_stem(text: str) -> str:
    stem = QUALITY_SUFFIX_RE.sub("", text)
    stem = stem.lower().replace("_", " ").replace("-", " ")
    return " ".join(stem.split())

def _derive_title_hints(sample: Path) -> tuple[str, str]:
    stem = sample.stem
    artist = ""
    title = stem
    if " - " in stem:
        artist, title = stem.split(" - ", 1)
    title = QUALITY_SUFFIX_RE.sub("", title)
    return artist.strip(), title.strip()

def _find_source_cache_path(sample: Path) -> Path | None:
    if not CACHE_DIR.exists():
        return None
    artist_hint, title_hint = _derive_title_hints(sample)
    target_stem = _normalize_stem(f"{artist_hint} {title_hint}".strip())
    artist_norm = _normalize_stem(artist_hint)
    title_norm = _normalize_stem(title_hint)
    exact_candidates: list[Path] = []
    fuzzy_candidates: list[Path] = []
    for path in CACHE_DIR.iterdir():
        if not path.is_file():
            continue
        norm = _normalize_stem(path.stem)
        if not norm:
            continue
        if target_stem and target_stem == norm:
            exact_candidates.append(path)
            continue
        if artist_norm and title_norm and artist_norm in norm and title_norm in norm:
            fuzzy_candidates.append(path)
            continue
        if not artist_norm and title_norm and norm == title_norm:
            fuzzy_candidates.append(path)
    if exact_candidates:
        return exact_candidates[0]
    if fuzzy_candidates:
        return fuzzy_candidates[0]
    return None

def _pick_cover_path() -> Path:
    if PICTURE_DIR.exists():
        default_png = PICTURE_DIR / "Albumdefault.png"
        if default_png.exists():
            return default_png
        preferred = sorted(p for p in PICTURE_DIR.glob("*_4.jpg") if p.is_file())
        if preferred:
            return preferred[0]
        files = [p for p in PICTURE_DIR.iterdir() if p.is_file()]
        if files:
            return files[0]
    return Path("Albumdefault.png")

def _run_active_helper(*, source_cache_path: Path, output_path: Path, cover_path: Path) -> dict[str, object]:
    repo_root = Path(__file__).resolve().parents[4]
    helper_script = repo_root / "scripts" / "qqmusic_direct_decrypt_call_test.py"
    python_exe = repo_root / ".venv" / "Scripts" / "python.exe"
    if not python_exe.exists():
        python_exe = Path(sys.executable)
    if not helper_script.exists():
        return {"status": "hook_error", "message": f"helper script missing: {helper_script}"}
    try:
        proc = subprocess.run(
            [
                str(python_exe), str(helper_script),
                "--arg0-hex", ACTIVE_ARG0_HEX,
                "--arg1-hex", ACTIVE_ARG1_HEX,
                "--source-cache-path", str(source_cache_path),
                "--output-path", str(output_path),
                "--cover-path", str(cover_path),
                "--settle-seconds", "4",
                "--stable-rounds", "2",
                "--grace-seconds", "2",
                "--json-summary",
            ],
            cwd=repo_root, capture_output=True, text=True, timeout=30,
        )
    except subprocess.TimeoutExpired:
        return {"status": "hook_error", "message": "QQ internal direct helper timed out"}
    if proc.returncode != 0:
        return {"status": "hook_error", "message": proc.stderr.strip() or proc.stdout.strip() or f"helper exited with {proc.returncode}"}
    summary_text = proc.stdout.strip().splitlines()[-1] if proc.stdout.strip() else "{}"
    try:
        summary = json.loads(summary_text)
    except json.JSONDecodeError:
        return {"status": "hook_error", "message": f"invalid helper output: {summary_text}"}
    if summary.get("output_exists"):
        return {"status": "staged", **summary}
    return {"status": "invoke_failed", "message": "helper completed but no output was produced", **summary}

__all__ = [
    "QUALITY_SUFFIX_RE",
    "CACHE_DIR",
    "PICTURE_DIR",
    "ACTIVE_ARG0_HEX",
    "ACTIVE_ARG1_HEX",
    "_detect_container_fast",
    "_find_qqmusic_pid",
    "_normalize_stem",
    "_derive_title_hints",
    "_find_source_cache_path",
    "_pick_cover_path",
    "_run_active_helper",
]
