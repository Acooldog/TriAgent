from __future__ import annotations

import pathlib
import traceback

from src.Infrastructure.adapters.agent.tools.agent_tools_batch import (
    run_decrypt_batch as _run_decrypt_batch,
)
from src.Infrastructure.adapters.agent.tools.agent_tools_state import (
    _find_kgg_db,
    _find_kugou_key,
    _to_path,
    tool,
)
from src.Infrastructure.adapters.storage.file_catalog import iter_supported_files
from src.Infrastructure.adapters.platforms.kugou.decoder.kugou_decoder import decode_file


def _format_tool_error(exc: Exception, tool_name: str) -> str:
    """格式化工具异常，保留类型和简化堆栈给模型。"""
    tb = exc.__traceback__
    if tb is not None:
        tb_lines = traceback.format_exception(type(exc), exc, tb)
        short_tb = "".join(tb_lines[-3:]).strip() if len(tb_lines) > 3 else "".join(tb_lines).strip()
    else:
        short_tb = "(无堆栈信息)"
    return f"❌ {tool_name} 失败 [{type(exc).__name__}]: {exc}\n--- 堆栈 ---\n{short_tb}"


@tool
def scan_files(directory: str, recursive: bool = True, file_types: str = "kugou") -> str:
    """扫描指定目录下的加密音乐文件。
    Args: directory: 要扫描的目录路径, recursive: 是否递归扫描子目录，默认为 True, file_types: 文件类型过滤，支持 "kugou"（酷狗格式）与 "qq"（QQ音乐格式）
    """
    try:
        input_path = _to_path(directory)
        if not input_path.exists():
            return f"错误：目录不存在 - {directory}"
        if not input_path.is_dir():
            return f"错误：路径不是目录 - {directory}"
        files = iter_supported_files(input_path, recursive)
        if not files:
            return f"在 {directory} 中未找到加密音乐文件"
        by_type: dict[str, list[str]] = {}
        for f in files:
            ext = f.suffix.lower()
            if ext not in by_type:
                by_type[ext] = []
            by_type[ext].append(str(f))
        parts = [f"在 {directory} 中找到 {len(files)} 个加密文件:"]
        for ext, paths in sorted(by_type.items()):
            parts.append(f"\n  {ext}: {len(paths)} 个")
            for p in paths[:10]:
                parts.append(f"    - {p}")
            if len(paths) > 10:
                parts.append(f"    ... 还有 {len(paths) - 10} 个")
        return "\n".join(parts)
    except Exception as exc:
        return _format_tool_error(exc, "scan_files")


@tool
def decrypt_kugou(input_path: str, output_dir: str, target_format: str = "auto") -> str:
    """【推荐】解密酷狗音乐加密文件（kgma/kgm/kgg/vpr）。input_path 可直接传**目录路径**，工具会自动批量处理目录下所有加密文件，一次搞定全部！也可传单个文件路径。
    ⚠️ 本工具输出平台原生格式（flac/ogg，取决于源文件），不做格式转换。如果需要特定格式（ogg/mp3/m4a/flac/wav），请在解密完成后调用 transcode_audio。
    Args: input_path: 加密文件路径 **或整个目录路径**（推荐传目录！）, output_dir: 解密后音频文件的输出目录, target_format: （仅用于去重判断）输出格式，可选 "auto"、"flac"、"m4a"、"mp3"、"wav"
    """
    try:
        src = _to_path(input_path)
        dst = _to_path(output_dir)
        dst.mkdir(parents=True, exist_ok=True)
        if not src.exists():
            return f"错误：输入路径不存在 - {input_path}"
        key_file = _find_kugou_key()
        if key_file is None:
            return "错误：未找到 kugou_key.xz 公钥文件，请确保 assets 目录下存在该文件"
        files_to_decrypt = [src] if src.is_file() else iter_supported_files(src, True)

        def _decrypt_one(fp: pathlib.Path) -> tuple[str | None, str]:
            summary = decode_file(fp, dst, key_path=key_file, kgg_db_path=_find_kgg_db() or pathlib.Path())
            return summary.get("output_path"), summary.get("detected_container", "bin")

        return _run_decrypt_batch(
            files_to_decrypt, _decrypt_one,
            log_prefix="[decrypt_kugou]",
            empty_msg=f"在 {input_path} 中未找到酷狗加密文件",
            platform_id="kugou", input_path=input_path, output_dir=str(dst),
            target_format=None if target_format == "auto" else target_format,
        )
    except Exception as exc:
        return _format_tool_error(exc, "decrypt_kugou")


@tool
def decrypt_qq(input_path: str, output_dir: str) -> str:
    """【推荐】解密 QQ 音乐加密文件（mflac/mgg/mmp4）。input_path 可直接传**目录路径**，工具会自动批量处理目录下所有加密文件，一次搞定全部！也可传单个文件路径。需要 QQ 音乐客户端已运行。
    ⚠️ 本工具输出平台原生格式（mflac→flac，mgg/mmp4→m4a），不做格式转换。如果需要特定格式（ogg/mp3/wav 等），请在解密完成后调用 transcode_audio。
    Args: input_path: 加密文件路径 **或整个目录路径**（推荐传目录！）, output_dir: 解密后音频文件的输出目录
    """
    try:
        src = _to_path(input_path)
        dst = _to_path(output_dir)
        dst.mkdir(parents=True, exist_ok=True)
        if not src.exists():
            return f"错误：输入路径不存在 - {input_path}"
        print(f"[decrypt_qq] 输入: {src} | 输出: {dst}")
        try:
            from src.Infrastructure.adapters.platforms.registry import build_platform_adapter
        except ImportError as exc:
            return f"错误：QQ 音乐解密运行时不可用 - {exc}"
        adapter = build_platform_adapter("qq")
        ok, _reason = adapter.validate_runtime({"process_match": "qqmusic", "auto_start": True})
        if not ok:
            return f"错误：{_reason or '未检测到运行中的 QQ 音乐客户端，自动启动也未成功。'}"
        print("[decrypt_qq] 运行时校验通过，QQ 音乐进程已就绪")
        files_to_decrypt = adapter.collect_files(src, True)

        def _decrypt_one(fp: pathlib.Path) -> tuple[str | None, str]:
            summary = adapter.decrypt_one(fp, dst, {"format_rules": {"mflac": "flac", "mgg": "m4a", "mmp4": "m4a"}}, log_dir=dst)
            return summary.get("output_path"), summary.get("detected_container", "bin")

        return _run_decrypt_batch(
            files_to_decrypt, _decrypt_one,
            log_prefix="[decrypt_qq]",
            empty_msg=f"在 {input_path} 中未找到 QQ 音乐加密文件（mflac/mgg/mmp4）",
            platform_id="qq", input_path=input_path, output_dir=str(dst),
        )
    except Exception as exc:
        return _format_tool_error(exc, "decrypt_qq")


@tool
def decrypt_netease(input_path: str, output_dir: str) -> str:
    """【推荐】解密网易云音乐加密文件（ncm 格式）。input_path 可直接传**目录路径**，工具会自动批量处理目录下所有加密文件，一次搞定全部！也可传单个文件路径。无需运行网易云音乐客户端。
    ⚠️ 本工具输出平台原生格式，不做格式转换。如果需要特定格式（ogg/mp3/m4a/flac/wav），请在解密完成后调用 transcode_audio。
    Args: input_path: 加密文件路径 **或整个目录路径**（推荐传目录！）, output_dir: 解密后音频文件的输出目录
    """
    try:
        src = _to_path(input_path)
        dst = _to_path(output_dir)
        dst.mkdir(parents=True, exist_ok=True)
        if not src.exists():
            return f"错误：输入路径不存在 - {input_path}"
        print(f"[decrypt_netease] 输入: {src} | 输出: {dst}")
        try:
            from src.Infrastructure.adapters.platforms.registry import build_platform_adapter
        except ImportError as exc:
            return f"错误：网易云解密运行时不可用 - {exc}"
        adapter = build_platform_adapter("netease")
        ok, _reason = adapter.validate_runtime({})
        if not ok:
            return "错误：网易云解密运行时校验失败。"
        print("[decrypt_netease] 运行时校验通过")
        files_to_decrypt = adapter.collect_files(src, True)

        def _decrypt_one(fp: pathlib.Path) -> tuple[str | None, str]:
            summary = adapter.decrypt_one(fp, dst, {}, log_dir=dst)
            return summary.get("output_path"), summary.get("detected_container", "bin")

        return _run_decrypt_batch(
            files_to_decrypt, _decrypt_one,
            log_prefix="[decrypt_netease]",
            empty_msg=f"在 {input_path} 中未找到网易云音乐加密文件（ncm）",
            platform_id="netease", input_path=input_path, output_dir=str(dst),
        )
    except Exception as exc:
        return _format_tool_error(exc, "decrypt_netease")


@tool
def decrypt_kuwo(input_path: str, output_dir: str) -> str:
    """【推荐】解密酷我音乐加密文件（kwm 格式）。input_path 可直接传**目录路径**，工具会自动批量处理目录下所有加密文件，一次搞定全部！也可传单个文件路径。无需运行酷我音乐客户端。
    ⚠️ 本工具输出平台原生格式，不做格式转换。如果需要特定格式（ogg/mp3/m4a/flac/wav），请在解密完成后调用 transcode_audio。
    Args: input_path: 加密文件路径 **或整个目录路径**（推荐传目录！）, output_dir: 解密后音频文件的输出目录
    """
    try:
        from src.Infrastructure.adapters.platforms.kuwo.unlockmusic_decoder import decrypt_kwm_file

        src = _to_path(input_path)
        dst = _to_path(output_dir)
        dst.mkdir(parents=True, exist_ok=True)
        if not src.exists():
            return f"错误：输入路径不存在 - {input_path}"
        print(f"[decrypt_kuwo] 输入: {src} | 输出: {dst}")
        KWM_SUFFIX = ".kwm"
        if src.is_file():
            files = [src] if src.suffix.lower() == KWM_SUFFIX else []
        else:
            files = sorted(p for p in src.rglob("*") if p.is_file() and p.suffix.lower() == KWM_SUFFIX)

        def _decrypt_one(fp: pathlib.Path) -> tuple[str | None, str]:
            final_path, ext = decrypt_kwm_file(fp, dst / fp.stem)
            return str(final_path), ext

        return _run_decrypt_batch(
            files, _decrypt_one,
            log_prefix="[decrypt_kuwo]",
            empty_msg=f"在 {input_path} 中未找到酷我音乐加密文件（kwm）",
            platform_id="kuwo", input_path=input_path, output_dir=str(dst),
        )
    except Exception as exc:
        return _format_tool_error(exc, "decrypt_kuwo")


__all__ = [
    "_run_decrypt_batch",
    "scan_files",
    "decrypt_kugou",
    "decrypt_qq",
    "decrypt_netease",
    "decrypt_kuwo",
]
