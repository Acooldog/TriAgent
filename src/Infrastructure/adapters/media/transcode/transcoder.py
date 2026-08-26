from __future__ import annotations

import base64
import pathlib
import tempfile
import time
from typing import Any

from src.Infrastructure.adapters.media.transcode.ffmpeg_runner import (
    _audio_option_args,
    _codec_args,
    _cover_metadata_args,
    _stream_selection_args,
)
from src.Infrastructure.adapters.media.probe.probe import (
    SUPPORTED_TARGET_FORMATS,
    _run_ffmpeg_safely,
    _subprocess_window_kwargs,
    detect_audio_container,
    fast_detect_container,
    normalize_target_format,
    probe_audio_container,
    probe_media_summary,
    resolve_ffmpeg_path,
    resolve_ffprobe_path,
    summary_to_log,
)
from src.Infrastructure.adapters.runtime.runtime_paths import RuntimePaths


def _run_ffmpeg_command(
    command: list[str],
    output_path: pathlib.Path,
    temp_output: pathlib.Path,
    ffmpeg_path: pathlib.Path,
) -> dict[str, str | int]:
    """执行 ffmpeg 命令并处理结果。"""
    try:
        completed = _run_ffmpeg_safely(command, timeout=300, desc="ffmpeg 执行")
        if completed.returncode != 0:
            stderr = completed.stderr.strip() or completed.stdout.strip() or f"ffmpeg rc={completed.returncode}"
            raise RuntimeError(f"ffmpeg 执行失败: {stderr}")
        if output_path.exists():
            output_path.unlink()
        temp_output.replace(output_path)
        return {
            "ffmpeg_path": str(ffmpeg_path),
            "output_path": str(output_path),
            "return_code": completed.returncode,
        }
    except RuntimeError:
        raise
    except Exception as exc:
        raise RuntimeError(f"ffmpeg 执行异常: {exc}")
    finally:
        if temp_output.exists():
            try:
                temp_output.unlink()
            except OSError:
                pass


def transcode_file(
    input_path: pathlib.Path,
    output_path: pathlib.Path,
    target_format: str,
    *,
    sample_rate_hz: int | None = None,
    bitrate_kbps: int | None = None,
) -> dict[str, str | int | None]:
    paths = RuntimePaths.discover()
    ffmpeg_path = resolve_ffmpeg_path(paths)
    if ffmpeg_path is None:
        raise FileNotFoundError("missing bundled ffmpeg executable in assets")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temp_output = output_path.with_name(f".{output_path.stem}.transcode.{time.time_ns()}{output_path.suffix}")
    command = [
        str(ffmpeg_path),
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(input_path),
        *_stream_selection_args(target_format),
        *_codec_args(target_format),
        *_cover_metadata_args(target_format),
        *_audio_option_args(
            target_format,
            sample_rate_hz=sample_rate_hz,
            bitrate_kbps=bitrate_kbps,
        ),
        str(temp_output),
    ]
    return _run_ffmpeg_command(command, output_path, temp_output, ffmpeg_path)


def attach_cover(input_path: pathlib.Path, output_path: pathlib.Path, cover_path: pathlib.Path) -> dict[str, str | int]:
    """为音频文件添加封面图片。"""
    paths = RuntimePaths.discover()
    ffmpeg_path = resolve_ffmpeg_path(paths)
    if ffmpeg_path is None:
        raise FileNotFoundError("missing bundled ffmpeg executable in assets")
    if output_path.suffix.lower() not in {".m4a", ".mp3", ".flac"}:
        return {
            "ffmpeg_path": str(ffmpeg_path),
            "output_path": str(output_path),
            "return_code": 0,
            "skipped": "unsupported_cover_container",
        }

    temp_output = output_path.with_name(f".{output_path.stem}.cover.{time.time_ns()}{output_path.suffix}")
    suffix = output_path.suffix.lower()

    if suffix == ".m4a":
        command = [
            str(ffmpeg_path), "-y", "-hide_banner", "-loglevel", "error",
            "-i", str(input_path), "-i", str(cover_path),
            "-map", "0:a:0", "-map", "1:v:0",
            "-c:a", "copy", "-c:v", "mjpeg",
            "-disposition:v:0", "attached_pic",
            "-metadata:s:v", "title=Cover",
            "-metadata:s:v", "comment=Cover (front)",
            str(temp_output),
        ]
    elif suffix == ".mp3":
        command = [
            str(ffmpeg_path), "-y", "-hide_banner", "-loglevel", "error",
            "-i", str(input_path), "-i", str(cover_path),
            "-map", "0:a:0", "-map", "1:v:0",
            "-c:a", "copy", "-c:v", "mjpeg",
            "-id3v2_version", "3",
            "-metadata:s:v", "title=Cover",
            "-metadata:s:v", "comment=Cover (front)",
            str(temp_output),
        ]
    else:  # .flac
        picture_data = cover_path.read_bytes()
        picture_b64 = base64.b64encode(picture_data).decode("ascii")
        mime = "image/png" if cover_path.suffix.lower() == ".png" else "image/jpeg"
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".meta", delete=False) as meta_file:
            meta_file.write(";FFMETADATA1\n")
            meta_file.write(f"metadata_block_picture={picture_b64}\n")
            meta_path = pathlib.Path(meta_file.name)
        try:
            command = [
                str(ffmpeg_path), "-y", "-hide_banner", "-loglevel", "error",
                "-i", str(input_path),
                "-f", "ffmetadata", "-i", str(meta_path),
                "-map_metadata", "1",
                "-map", "0:a:0",
                "-c:a", "copy",
                "-metadata", f"comment=Cover MIME {mime}",
                str(temp_output),
            ]
        finally:
            meta_path.unlink(missing_ok=True)

    return _run_ffmpeg_command(command, output_path, temp_output, ffmpeg_path)


# --- TranscodePort adapter (implements src.Domain.ports.TranscodePort) ---

class _TranscodeAdapter:
    """Structural implementation of ``src.Domain.ports.TranscodePort``.

    Wraps the module-level functions (transcode_file, probe_media_summary,
    summary_to_log, normalize_target_format) so the Application layer can
    inject a single dependency instead of importing individual functions.
    """

    def transcode_file(
        self,
        input_path: pathlib.Path,
        output_path: pathlib.Path,
        target_format: str,
        *,
        sample_rate_hz: int | None = None,
        bitrate_kbps: int | None = None,
    ) -> dict[str, Any]:
        return transcode_file(
            input_path, output_path, target_format,
            sample_rate_hz=sample_rate_hz, bitrate_kbps=bitrate_kbps,
        )

    def probe_media_summary(self, path: pathlib.Path) -> dict[str, Any]:
        return probe_media_summary(path)

    def summary_to_log(self, summary: dict[str, Any]) -> str:
        return summary_to_log(summary)

    def normalize_target_format(self, value: str) -> str:
        return normalize_target_format(value)


__all__ = [
    "SUPPORTED_TARGET_FORMATS",
    "transcode_file",
    "attach_cover",
    "resolve_ffmpeg_path",
    "resolve_ffprobe_path",
    "_subprocess_window_kwargs",
    "_run_ffmpeg_safely",
    "_codec_args",
    "_stream_selection_args",
    "_cover_metadata_args",
    "_audio_option_args",
    "normalize_target_format",
    "detect_audio_container",
    "fast_detect_container",
    "probe_audio_container",
    "probe_media_summary",
    "summary_to_log",
    "_TranscodeAdapter",
]
