from __future__ import annotations


def _codec_args(target_format: str) -> list[str]:
    """设置编码器。bitrate 留给 _audio_option_args 处理，避免重复。"""
    if target_format == "mp3":
        return ["-codec:a", "libmp3lame", "-q:a", "2"]
    if target_format == "m4a":
        return ["-codec:a", "aac"]
    if target_format == "wav":
        return ["-codec:a", "pcm_s16le"]
    if target_format == "flac":
        return ["-codec:a", "flac"]
    if target_format == "ogg":
        return ["-codec:a", "libvorbis"]
    return []


def _stream_selection_args(target_format: str) -> list[str]:
    """选择音频流。用 -vn 彻底排除视频流（含 h264 等），避免音频容器尝试打包视频导致失败。"""
    if target_format in {"mp3", "m4a", "flac", "ogg"}:
        return ["-map", "0:a:0", "-vn", "-sn", "-dn"]
    if target_format == "wav":
        return ["-map", "0:a:0", "-vn", "-sn", "-dn"]
    return []


def _cover_metadata_args(target_format: str) -> list[str]:
    """为支持封面的输出格式添加格式特定的封面保留参数。"""
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
    # 比特率：显式传则用传值；m4a/ogg 默认 256k/192k；mp3 用 -q:a 而非 -b:a
    if target_format in {"mp3"}:
        if bitrate_kbps:
            args.extend(["-b:a", f"{int(bitrate_kbps)}k"])
    elif target_format in {"m4a"}:
        br = int(bitrate_kbps) if bitrate_kbps else 256
        args.extend(["-b:a", f"{br}k"])
    elif target_format in {"ogg"}:
        br = int(bitrate_kbps) if bitrate_kbps else 192
        args.extend(["-b:a", f"{br}k"])
    return args


def _filter_args(
    *,
    sample_rate_hz: int | None = None,
    gain_db: float | None = None,
) -> list[str]:
    """音频滤镜参数（采样率转换、增益调整），用于 process_audio 工具。"""
    args: list[str] = []
    filters: list[str] = []
    if gain_db is not None:
        filters.append(f"volume={float(gain_db):.1f}dB")
    if sample_rate_hz is not None:
        filters.append(f"aresample={int(sample_rate_hz)}")
    if filters:
        args.extend(["-af", ",".join(filters)])
    return args


__all__ = [
    "_codec_args",
    "_stream_selection_args",
    "_cover_metadata_args",
    "_audio_option_args",
    "_filter_args",
]
