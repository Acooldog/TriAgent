from __future__ import annotations

import json
from typing import Any

from src.Infrastructure.adapters.media.probe.probe_container import (
    _extract_format_from_stderr,
    _normalize_container,
    _run_ffmpeg_safely,
    fast_detect_container,
    resolve_ffmpeg_path,
    resolve_ffprobe_path,
)
from src.Infrastructure.adapters.runtime.runtime_paths import RuntimePaths

try:
    from mutagen.flac import FLAC
    from mutagen.id3 import ID3
    from mutagen.mp4 import MP4
except Exception:  # pragma: no cover - optional runtime dependency
    FLAC = None  # type: ignore[assignment]
    ID3 = None  # type: ignore[assignment]
    MP4 = None  # type: ignore[assignment]


def _probe_media_summary_with_mutagen(input_path: pathlib.Path, container_hint: str) -> dict[str, Any] | None:
    if not input_path.exists():
        return None
    try:
        metadata: dict[str, str] = {}
        cover = False
        cover_codec = ""
        suffix = input_path.suffix.lower()
        if suffix == ".mp3" and ID3 is not None:
            tags = ID3(str(input_path))
            title = tags.get("TIT2")
            artist = tags.get("TPE1")
            album = tags.get("TALB")
            if title:
                metadata["title"] = str(title)
            if artist:
                metadata["artist"] = str(artist)
            if album:
                metadata["album"] = str(album)
            cover = bool(tags.getall("APIC"))
            cover_codec = "apic" if cover else ""
        elif suffix == ".m4a" and MP4 is not None:
            audio = MP4(str(input_path))
            tags = audio.tags or {}
            if "\xa9nam" in tags and tags["\xa9nam"]:
                metadata["title"] = str(tags["\xa9nam"][0])
            if "\xa9ART" in tags and tags["\xa9ART"]:
                metadata["artist"] = str(tags["\xa9ART"][0])
            if "\xa9alb" in tags and tags["\xa9alb"]:
                metadata["album"] = str(tags["\xa9alb"][0])
            cover = bool(tags.get("covr"))
            cover_codec = "covr" if cover else ""
        elif suffix == ".flac" and FLAC is not None:
            audio = FLAC(str(input_path))
            if audio.get("title"):
                metadata["title"] = str(audio.get("title")[0])
            if audio.get("artist"):
                metadata["artist"] = str(audio.get("artist")[0])
            if audio.get("album"):
                metadata["album"] = str(audio.get("album")[0])
            cover = bool(audio.pictures)
            cover_codec = "picture" if cover else ""
        else:
            return None
        return {
            "path": str(input_path),
            "probe_source": "mutagen",
            "container": container_hint if container_hint != "bin" else fast_detect_container(input_path),
            "audio_streams": 1,
            "video_streams": 1 if cover else 0,
            "cover": cover,
            "cover_codec": cover_codec,
            "metadata": metadata,
        }
    except Exception:
        return None


def probe_media_summary(input_path: pathlib.Path) -> dict[str, Any]:
    paths = RuntimePaths.discover()
    ffmpeg_path = resolve_ffmpeg_path(paths)
    ffprobe_path = resolve_ffprobe_path(paths)
    fast_container = fast_detect_container(input_path)
    mutagen_summary = _probe_media_summary_with_mutagen(input_path, fast_container)
    if (ffmpeg_path is None and ffprobe_path is None) or not input_path.exists():
        if mutagen_summary is not None:
            return mutagen_summary
        return {
            "path": str(input_path),
            "probe_source": "missing_ffmpeg_or_input",
            "container": fast_container,
            "audio_streams": 0,
            "video_streams": 0,
            "cover": False,
            "cover_codec": "",
            "metadata": {},
        }

    probe_exe = ffprobe_path or ffmpeg_path
    is_ffprobe = ffprobe_path is not None
    if is_ffprobe:
        command = [
            str(ffprobe_path),
            "-hide_banner",
            "-loglevel",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            "-i",
            str(input_path),
        ]
        try:
            completed = _run_ffmpeg_safely(command, timeout=60, desc="音频元数据探测")
        except RuntimeError as exc:
            print(f"[probe_audio_metadata] ffprobe 超时: {input_path.name} - {exc}")
            if mutagen_summary is not None:
                return mutagen_summary
            return {
                "path": str(input_path),
                "probe_source": "ffprobe_timeout",
                "container": fast_container,
                "audio_streams": 0,
                "video_streams": 0,
                "cover": False,
                "cover_codec": "",
                "metadata": {},
                "stderr": str(exc),
            }
        if completed.returncode != 0:
            if mutagen_summary is not None:
                return mutagen_summary
            return {
                "path": str(input_path),
                "probe_source": "ffprobe_failed",
                "container": fast_container,
                "audio_streams": 0,
                "video_streams": 0,
                "cover": False,
                "cover_codec": "",
                "metadata": {},
                "stderr": (completed.stderr or "").strip(),
            }
        try:
            data = json.loads(completed.stdout)
        except (json.JSONDecodeError, ValueError):
            if mutagen_summary is not None:
                return mutagen_summary
            return {
                "path": str(input_path),
                "probe_source": "ffprobe_parse_failed",
                "container": fast_container,
                "audio_streams": 0,
                "video_streams": 0,
                "cover": False,
                "cover_codec": "",
                "metadata": {},
            }
    else:
        command = [
            str(ffmpeg_path),
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(input_path),
            "-f",
            "null",
            "NUL",
        ]
        try:
            completed = _run_ffmpeg_safely(command, timeout=60, desc="容器类型回退探测")
        except RuntimeError as exc:
            print(f"[probe_audio_metadata] ffmpeg fallback 超时: {input_path.name} - {exc}")
            format_name = ""
        else:
            format_name = _extract_format_from_stderr(completed.stderr or "")
        return {
            "path": str(input_path),
            "probe_source": "ffmpeg_fallback",
            "container": _normalize_container(format_name or fast_container),
            "audio_streams": 1,
            "video_streams": 0,
            "cover": bool((mutagen_summary or {}).get("cover")),
            "cover_codec": str((mutagen_summary or {}).get("cover_codec") or ""),
            "metadata": dict((mutagen_summary or {}).get("metadata") or {}),
        }

    streams = list(data.get("streams") or [])
    fmt = data.get("format") or {}
    audio_streams = [stream for stream in streams if str(stream.get("codec_type")) == "audio"]
    video_streams = [stream for stream in streams if str(stream.get("codec_type")) == "video"]
    cover_stream = next(
        (
            stream
            for stream in video_streams
            if bool((stream.get("disposition") or {}).get("attached_pic"))
        ),
        None,
    )
    container = str(fmt.get("format_name") or fast_detect_container(input_path)).split(",", 1)[0].strip().lower()
    container = _normalize_container(container)
    return {
        "path": str(input_path),
        "probe_source": "ffprobe_json",
        "container": container,
        "audio_streams": len(audio_streams),
        "video_streams": len(video_streams),
        "cover": bool((mutagen_summary or {}).get("cover")) or cover_stream is not None,
        "cover_codec": str((mutagen_summary or {}).get("cover_codec") or (cover_stream or {}).get("codec_name") or ""),
        "metadata": dict((mutagen_summary or {}).get("metadata") or fmt.get("tags") or {}),
    }


def summary_to_log(summary: dict[str, Any]) -> str:
    metadata = summary.get("metadata") or {}
    title = str(metadata.get("title") or metadata.get("TITLE") or "").strip()
    artist = str(metadata.get("artist") or metadata.get("ARTIST") or "").strip()
    album = str(metadata.get("album") or metadata.get("ALBUM") or "").strip()
    return (
        f"container={summary.get('container', '')} "
        f"audio={summary.get('audio_streams', 0)} "
        f"video={summary.get('video_streams', 0)} "
        f"cover={'yes' if summary.get('cover') else 'no'} "
        f"cover_codec={summary.get('cover_codec', '')} "
        f"title={title} artist={artist} album={album} "
        f"probe={summary.get('probe_source', '')}"
    ).strip()


__all__ = [
    "probe_media_summary",
    "summary_to_log",
    "_probe_media_summary_with_mutagen",
]
