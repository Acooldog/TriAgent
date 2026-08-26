from __future__ import annotations

import subprocess
from typing import Any

from src.Infrastructure.runtime_paths import RuntimePaths

try:
    from mutagen.flac import FLAC
    from mutagen.id3 import ID3
    from mutagen.mp4 import MP4
except Exception:  # pragma: no cover - optional runtime dependency
    FLAC = None  # type: ignore[assignment]
    ID3 = None  # type: ignore[assignment]
    MP4 = None  # type: ignore[assignment]


SUPPORTED_TARGET_FORMATS = {"auto", "flac", "m4a", "mp3", "wav"}


def _subprocess_window_kwargs() -> dict[str, object]:
    if hasattr(subprocess, "CREATE_NO_WINDOW"):
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        return {
            "creationflags": subprocess.CREATE_NO_WINDOW,
            "startupinfo": startupinfo,
        }
    return {}


def _run_ffmpeg_safely(
    command: list[str],
    timeout: int = 300,
    desc: str = "ffmpeg",
) -> subprocess.CompletedProcess[str]:
    if "-nostdin" not in command:
        command = [command[0], "-nostdin", *command[1:]]

    proc = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        **_subprocess_window_kwargs(),
    )
    try:
        stdout, stderr = proc.communicate(timeout=timeout)
        return subprocess.CompletedProcess(
            args=command,
            returncode=proc.returncode,
            stdout=stdout or "",
            stderr=stderr or "",
        )
    except subprocess.TimeoutExpired:
        proc.kill()
        try:
            proc.wait(timeout=10)
        except Exception:
            pass
        if hasattr(subprocess, "CREATE_NO_WINDOW"):
            try:
                subprocess.run(
                    ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                    capture_output=True,
                    timeout=5,
                    **_subprocess_window_kwargs(),
                )
            except Exception:
                pass
        raise RuntimeError(f"{desc} 超时（{timeout}秒），已强制终止")


def resolve_ffmpeg_path(paths: RuntimePaths | None = None) -> pathlib.Path | None:
    paths = paths or RuntimePaths.discover()
    candidates: list[pathlib.Path] = []
    for pattern in ("ffmpeg*.exe", "ffmpeg.exe"):
        candidates.extend(sorted(paths.assets_dir.glob(pattern)))
        candidates.extend(sorted((paths.bundle_dir / "assets").glob(pattern)))
        candidates.extend(sorted((paths.root_dir / "assets").glob(pattern)))
    seen: set[str] = set()
    for candidate in candidates:
        key = str(candidate).lower()
        if key in seen:
            continue
        seen.add(key)
        if candidate.exists() and candidate.is_file():
            return candidate
    return None


def resolve_ffprobe_path(paths: RuntimePaths | None = None) -> pathlib.Path | None:
    paths = paths or RuntimePaths.discover()
    candidates: list[pathlib.Path] = []
    for pattern in ("ffprobe*.exe", "ffprobe.exe"):
        candidates.extend(sorted(paths.assets_dir.glob(pattern)))
        candidates.extend(sorted((paths.bundle_dir / "assets").glob(pattern)))
        candidates.extend(sorted((paths.root_dir / "assets").glob(pattern)))
    ffmpeg_path = resolve_ffmpeg_path(paths)
    if ffmpeg_path is not None:
        sibling = ffmpeg_path.parent / ffmpeg_path.name.replace("ffmpeg", "ffprobe")
        if sibling.exists() and sibling.is_file():
            candidates.insert(0, sibling)
    seen: set[str] = set()
    for candidate in candidates:
        key = str(candidate).lower()
        if key in seen:
            continue
        seen.add(key)
        if candidate.exists() and candidate.is_file():
            return candidate
    return None


def normalize_target_format(value: str) -> str:
    normalized = str(value or "auto").strip().lower()
    if normalized == "ogg":
        normalized = "m4a"
    if normalized not in SUPPORTED_TARGET_FORMATS:
        raise ValueError(f"unsupported target format: {value}")
    return normalized


def fast_detect_container_from_bytes(head: bytes) -> str:
    if len(head) < 4:
        return "bin"
    if head[:4] == b"fLaC":
        return "flac"
    if head[:4] == b"OggS":
        return "ogg"
    if head[:4] == b"RIFF" and len(head) >= 12 and head[8:12] == b"WAVE":
        return "wav"
    if head[:3] == b"ID3":
        return "mp3"
    if len(head) >= 2 and head[0] == 0xFF and head[1] in (0xFB, 0xF3, 0xF2):
        return "mp3"
    if len(head) >= 12 and head[4:8] == b"ftyp":
        return "m4a"
    return "bin"


def fast_detect_container(path: pathlib.Path) -> str:
    if not path.exists() or path.stat().st_size < 4:
        return "bin"
    return fast_detect_container_from_bytes(path.read_bytes()[:64])


def probe_audio_container(input_path: pathlib.Path) -> str | None:
    paths = RuntimePaths.discover()
    ffmpeg_path = resolve_ffmpeg_path(paths)
    if ffmpeg_path is None:
        return None
    command = [
        str(ffmpeg_path),
        "-hide_banner",
        "-i",
        str(input_path),
        "-f",
        "null",
        "NUL",
    ]
    try:
        completed = _run_ffmpeg_safely(command, timeout=60, desc="音频格式探测")
    except RuntimeError as exc:
        print(f"[probe_audio_container] 超时或失败: {input_path.name} - {exc}")
        return None
    stderr = completed.stderr or ""
    marker = "Input #0, "
    start = stderr.find(marker)
    if start < 0:
        return None
    after = stderr[start + len(marker):]
    format_name = after.split(",", 1)[0].strip().lower()
    if format_name == "flac":
        return "flac"
    if format_name == "ogg":
        return "ogg"
    if format_name in {"wav", "wav_pipe"}:
        return "wav"
    if format_name == "mp3":
        return "mp3"
    if format_name in {"mov", "mp4", "m4a", "3gp", "3g2", "mj2"}:
        return "m4a"
    return None


def detect_audio_container(input_path: pathlib.Path) -> tuple[str, str]:
    fast = fast_detect_container(input_path)
    if fast != "bin":
        return fast, "fast"
    probed = probe_audio_container(input_path)
    if probed:
        return probed, "ffmpeg_probe"
    return "bin", "unrecognized"


def _extract_format_from_stderr(stderr: str) -> str:
    marker = "Input #0, "
    start = stderr.find(marker)
    if start < 0:
        return ""
    after = stderr[start + len(marker):]
    return after.split(",", 1)[0].strip().lower()


def _normalize_container(container: str) -> str:
    if container == "ogg":
        return "m4a"
    return container


__all__ = [
    "SUPPORTED_TARGET_FORMATS",
    "fast_detect_container",
    "fast_detect_container_from_bytes",
    "probe_audio_container",
    "detect_audio_container",
    "normalize_target_format",
    "resolve_ffmpeg_path",
    "resolve_ffprobe_path",
    "_subprocess_window_kwargs",
    "_run_ffmpeg_safely",
    "_extract_format_from_stderr",
    "_normalize_container",
    "FLAC",
    "ID3",
    "MP4",
]
