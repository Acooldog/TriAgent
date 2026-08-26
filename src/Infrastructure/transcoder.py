from __future__ import annotations

import base64
import json
import pathlib
import subprocess
import tempfile
import time
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
    """安全执行 ffmpeg/ffprobe 命令，防止卡死。

    使用 Popen + communicate(timeout=...) 避免 capture_output 的管道死锁，
    并在超时后强制终止进程树。所有命令添加 -nostdin 防止等待标准输入。
    """
    # 确保命令包含 -nostdin，防止 ffmpeg 等待 stdin
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
        # 强制杀死进程，Windows 上需要 taskkill 终止子进程
        proc.kill()
        try:
            proc.wait(timeout=10)
        except Exception:
            pass
        # Windows 上用 taskkill 兜底
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


def normalize_target_format(value: str) -> str:
    normalized = str(value or "auto").strip().lower()
    if normalized == "ogg":
        normalized = "m4a"
    if normalized not in SUPPORTED_TARGET_FORMATS:
        raise ValueError(f"unsupported target format: {value}")
    return normalized


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
    """查找 ffprobe 可执行文件，与 ffmpeg 同目录。"""
    paths = paths or RuntimePaths.discover()
    candidates: list[pathlib.Path] = []
    for pattern in ("ffprobe*.exe", "ffprobe.exe"):
        candidates.extend(sorted(paths.assets_dir.glob(pattern)))
        candidates.extend(sorted((paths.bundle_dir / "assets").glob(pattern)))
        candidates.extend(sorted((paths.root_dir / "assets").glob(pattern)))
    # 也检查 ffmpeg 同目录下是否有 ffprobe
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

    # 优先使用 ffprobe（支持 JSON 输出流信息）
    probe_exe = ffprobe_path or ffmpeg_path
    is_ffprobe = ffprobe_path is not None
    if is_ffprobe:
        # ffprobe 命令：输出 JSON 格式的流和容器信息
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
        # ffprobe 输出到 stdout，不需要输出文件
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
        # ffprobe 输出到 stdout
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
        # 回退到 ffmpeg（使用 null 输出探测容器类型）
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
        streams = []
        fmt = {"format_name": format_name}
        # ffmpeg 回退：只能获取容器类型，无法获取详细流信息
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


def _extract_format_from_stderr(stderr: str) -> str:
    """从 ffmpeg stderr 中提取容器格式名。"""
    marker = "Input #0, "
    start = stderr.find(marker)
    if start < 0:
        return ""
    after = stderr[start + len(marker):]
    return after.split(",", 1)[0].strip().lower()


def _normalize_container(container: str) -> str:
    """规范化容器类型名。"""
    if container == "ogg":
        return "m4a"
    return container


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


def _codec_args(target_format: str) -> list[str]:
    if target_format == "mp3":
        return ["-codec:a", "libmp3lame", "-q:a", "2"]
    if target_format == "m4a":
        return ["-codec:a", "aac", "-b:a", "256k"]
    if target_format == "wav":
        return ["-codec:a", "pcm_s16le"]
    if target_format == "flac":
        return ["-codec:a", "flac"]
    return []


def _stream_selection_args(target_format: str) -> list[str]:
    """选择音频流和封面（如果支持）。

    mp3/m4a/flac 支持封面内嵌，保留视频流（封面以 attached_pic 形式存储）；
    wav 不支持封面，使用 -vn 丢弃视频流。
    """
    if target_format in {"mp3", "m4a", "flac"}:
        # 使用 -map 0:v? 可选映射视频流（封面），不强制要求输入存在视频流
        return ["-map", "0:a:0", "-map", "0:v?", "-sn", "-dn"]
    if target_format == "wav":
        return ["-map", "0:a:0", "-vn", "-sn", "-dn"]
    return []


def _cover_metadata_args(target_format: str) -> list[str]:
    """为支持封面的输出格式添加格式特定的封面保留参数。

    mp3: 强制 attached_pic 封面 + ID3v2 版本 + ID3v1 兼容
    m4a: MP4 容器自带 cover atom，设置 attached_pic 即可
    flac: 原生支持嵌入式图片，设置 attached_pic 即可
    wav: 不支持封面
    """
    if target_format == "mp3":
        return [
            "-disposition:v", "attached_pic",
            "-id3v2_version", "3",
            "-write_id3v1", "1",
        ]
    if target_format == "m4a":
        return ["-disposition:v", "attached_pic"]
    if target_format == "flac":
        return ["-disposition:v", "attached_pic"]
    return []


def _audio_option_args(
    target_format: str,
    *,
    sample_rate_hz: int | None = None,
    bitrate_kbps: int | None = None,
) -> list[str]:
    args: list[str] = []
    if sample_rate_hz:
        args.extend(["-ar", str(int(sample_rate_hz))])
    if bitrate_kbps and target_format in {"mp3", "m4a"}:
        args.extend(["-b:a", f"{int(bitrate_kbps)}k"])
    return args


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
    try:
        completed = _run_ffmpeg_safely(command, timeout=300, desc="ffmpeg 转码")
        if completed.returncode != 0:
            stderr = completed.stderr.strip() or completed.stdout.strip() or f"ffmpeg rc={completed.returncode}"
            raise RuntimeError(f"ffmpeg transcode failed: {stderr}")
        if output_path.exists():
            output_path.unlink()
        temp_output.replace(output_path)
        return {"ffmpeg_path": str(ffmpeg_path), "output_path": str(output_path), "return_code": completed.returncode}
    except RuntimeError:
        raise
    except Exception as exc:
        raise RuntimeError(f"ffmpeg 转码异常: {exc}")
    finally:
        if temp_output.exists():
            try:
                temp_output.unlink()
            except OSError:
                pass


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


