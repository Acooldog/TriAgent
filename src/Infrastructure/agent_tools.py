from __future__ import annotations

import os
import pathlib
import shutil
import threading
from typing import Annotated, Any

from pydantic import BeforeValidator

from src.Infrastructure.config_repository import auto_find_kgg_db_path, auto_find_kugou_key
from src.Infrastructure.file_catalog import SUPPORTED_SUFFIXES, iter_supported_files
from src.Infrastructure.kugou_decoder import (
    DEFAULT_KGG_DB_PATH,
    DEFAULT_KEY_PATH,
    decode_file,
    detect_extension,
)
from src.Infrastructure.processed_index import (
    INDEX_FILENAME,
    mark_processed,
    plan_files,
    save_index,
)
from src.Infrastructure.runtime_paths import RuntimePaths
from src.Infrastructure.soft_sandbox import get_sandbox

try:
    from langchain_core.tools import tool
except ImportError:
    def tool(*args: Any, **kwargs: Any):
        def _decorator(func):
            func.is_langchain_tool = True
            func.tool_name = kwargs.get("name", func.__name__)
            func.tool_description = kwargs.get("description", func.__doc__ or "")
            return func
        if len(args) == 1 and callable(args[0]):
            return _decorator(args[0])
        return _decorator

# 延迟初始化 PATHS，避免模块加载时路径尚未准备好
_PATHS: RuntimePaths | None = None


def _get_paths() -> RuntimePaths:
    global _PATHS
    if _PATHS is None:
        _PATHS = RuntimePaths.discover()
    return _PATHS

TOOL_DESCRIPTIONS = {
    "scan_files": "扫描指定目录下的加密音乐文件（支持 kgma/kgm/kgg/vpr/mflac/mgg/mmp4/ncm/kwm 格式），返回找到的文件列表和数量。",
    "decrypt_kugou": "解密酷狗音乐加密文件（kgma、kgm、kgg、vpr 等格式），输出为可播放的音频文件。",
    "decrypt_qq": "解密 QQ 音乐加密文件（mflac、mgg、mmp4 格式），输出为可播放的音频文件。需要 QQ 音乐客户端已运行。",
    "decrypt_netease": "解密网易云音乐加密文件（ncm 格式），输出为可播放的音频文件。无需运行网易云音乐客户端。",
    "decrypt_kuwo": "解密酷我音乐加密文件（kwm 格式），输出为可播放的音频文件。无需运行酷我音乐客户端。",
    "transcode_audio": "调用 ffmpeg 将音频文件转换为目标格式（mp3/m4a/flac/wav）。支持单文件或目录批量处理。",
    "verify_audio_integrity": "校验音频文件是否完整可播放，通过容器探测和流信息分析判断文件是否损坏。解密或格式转换后必须调用本工具确认结果。",
    "copy_files": "将文件从源路径复制到目标目录（保留源文件），保持文件名不变。支持批量操作。",
    "move_files": "将文件从源目录移动到目标目录（不保留源文件），支持按扩展名过滤。适用于整理文件结构，如把flac/ogg移到子目录。",
    "rename_file": "重命名单个文件，保持在原目录不变。目标名已存在时报错以防止覆盖。",
    "run_cli_safely": "安全执行命令行程序，统一处理中文路径与编码（subprocess 列表传参 + UTF-8）。凡需调用外部命令必须用本工具，禁止 os.system 或 shell=True。",
    "rag_retrieve": "在本地知识库中检索与问题相关的已沉淀解决方案/经验（如中文路径处理、失败续传约定）。遇到不确定如何处理的问题时先检索知识库。",
    "rag_ingest": "把一条经验/解决方案写入本地知识库，便于后续检索复用。仅在完成了一条值得沉淀的通用经验时调用。",
    "detect_format": "检测音频文件的容器格式（flac/mp3/m4a/wav/ogg 等），通过读取文件头特征判断。",
    "list_directory": "列出指定目录下的所有文件和子目录，返回文件名称列表。",
    "ask_user": "遇到不确定的操作时询问用户。给出清晰的问题和 2~4 个互斥选项，用户选择后返回所选内容。常用于：处理记录与实际输出不一致、目标文件已存在等无法判断用户意图的场景。",
    "sandbox_manage": "管理文件操作沙箱：授权/取消授权目录、查看当前授权目录。所有文件操作必须在授权目录范围内。",
}


# 使用全局变量存储 ask_user 回调（而非 threading.local），
# 因为 LangChain 的工具调用可能在不同线程执行，threading.local 会导致回调丢失。
_ask_user_callback: Any | None = None
_callback_lock = threading.Lock()


def set_ask_user_callback(callback: Any) -> None:
    """注入 ask_user 工具的回调（worker 启动 agent 前调用）。"""
    global _ask_user_callback
    with _callback_lock:
        _ask_user_callback = callback


def _get_ask_user_callback() -> Any | None:
    """获取 ask_user 回调。"""
    global _ask_user_callback
    with _callback_lock:
        return _ask_user_callback


def set_permission_mode(mode: str) -> None:
    """注入权限模式（worker 启动 agent 前调用）。
    可选值：restricted / standard / full。"""
    global _permission_mode
    _permission_mode = mode


def _get_permission_mode() -> str:
    """获取当前权限模式。默认 standard。"""
    return _permission_mode

def _find_kugou_key() -> pathlib.Path | None:
    key = auto_find_kugou_key(_get_paths())
    return key or (DEFAULT_KEY_PATH if DEFAULT_KEY_PATH.exists() else None)

def _find_kgg_db() -> pathlib.Path | None:
    db = auto_find_kgg_db_path()
    return db or (DEFAULT_KGG_DB_PATH if DEFAULT_KGG_DB_PATH.exists() else None)

def _to_path(value: str | os.PathLike[str] | pathlib.Path) -> pathlib.Path:
    return pathlib.Path(str(value)).expanduser().resolve()


@tool
def scan_files(directory: str, recursive: bool = True, file_types: str = "kugou") -> str:
    """扫描指定目录下的加密音乐文件。

    Args:
        directory: 要扫描的目录路径
        recursive: 是否递归扫描子目录，默认为 True
        file_types: 文件类型过滤，支持 "kugou"（酷狗格式）与 "qq"（QQ音乐格式）
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
        return f"扫描失败：{exc}"


@tool
def decrypt_kugou(input_path: str, output_dir: str, target_format: str = "auto") -> str:
    """解密酷狗音乐加密文件（kgma/kgm/kgg/vpr），输出为可播放的音频文件。

    Args:
        input_path: 加密文件或包含加密文件的目录路径
        output_dir: 解密后音频文件的输出目录
        target_format: 输出格式，可选 "auto"、"flac"、"m4a"、"mp3"、"wav"
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

        if src.is_file():
            files_to_decrypt = [src]
        else:
            files_to_decrypt = iter_supported_files(src, True)

        if not files_to_decrypt:
            return f"在 {input_path} 中未找到酷狗加密文件"

        pending, skipped = plan_files(files_to_decrypt)
        if skipped:
            print(f"[decrypt_kugou] 跳过已处理文件 {len(skipped)} 个（见 {INDEX_FILENAME}）")
        if not pending:
            return f"所有 {len(skipped)} 个文件均已处理过（见 {INDEX_FILENAME}），本次跳过。"

        results = []
        success = 0
        failed = 0

        for item in pending:
            file_path = item["file"]
            index = item["index"]
            index_dir = item["index_dir"]
            index_path = item["index_path"]
            try:
                summary = decode_file(
                    file_path,
                    dst,
                    key_path=key_file,
                    kgg_db_path=_find_kgg_db() or pathlib.Path(),
                )
                out_path = summary.get("output_path", "")
                container = summary.get("detected_container", "bin")
                if out_path:
                    results.append(f"  成功: {file_path.name} -> {out_path} [{container}]")
                    success += 1
                    mark_processed(index, file_path, index_dir, str(out_path), container)
                    save_index(index_path, index)
                else:
                    results.append(f"  失败: {file_path.name} - 未识别的音频容器")
                    failed += 1
            except Exception as exc:
                results.append(f"  失败: {file_path.name} - {exc}")
                failed += 1

        header = f"解密完成：共 {len(pending)} 个待处理，成功 {success}，失败 {failed}，跳过 {len(skipped)}"
        return header + "\n" + "\n".join(results)
    except Exception as exc:
        return f"解密失败：{exc}"


@tool
def decrypt_qq(input_path: str, output_dir: str) -> str:
    """解密 QQ 音乐加密文件（mflac/mgg/mmp4），输出为可播放的音频文件。需要 QQ 音乐客户端已运行。

    Args:
        input_path: 加密文件或包含加密文件的目录路径
        output_dir: 解密后音频文件的输出目录
    """
    try:
        src = _to_path(input_path)
        dst = _to_path(output_dir)
        dst.mkdir(parents=True, exist_ok=True)

        if not src.exists():
            return f"错误：输入路径不存在 - {input_path}"

        print(f"[decrypt_qq] 输入: {src} | 输出: {dst}")
        try:
            from src.Infrastructure.platforms.registry import build_platform_adapter
        except ImportError as exc:
            return f"错误：QQ 音乐解密运行时不可用 - {exc}"

        adapter = build_platform_adapter("qq")
        ok, _reason = adapter.validate_runtime({"process_match": "qqmusic"})
        if not ok:
            return "错误：未检测到运行中的 QQ 音乐客户端，请先启动 QQ 音乐后重试。"
        print("[decrypt_qq] 运行时校验通过，QQ 音乐进程已就绪")

        files_to_decrypt = adapter.collect_files(src, True)
        if not files_to_decrypt:
            return f"在 {input_path} 中未找到 QQ 音乐加密文件（mflac/mgg/mmp4）"
        print(f"[decrypt_qq] 待解密文件 {len(files_to_decrypt)} 个")

        pending, skipped = plan_files(files_to_decrypt)
        if skipped:
            print(f"[decrypt_qq] 跳过已处理文件 {len(skipped)} 个（见 {INDEX_FILENAME}）")
        if not pending:
            return f"所有 {len(skipped)} 个文件均已处理过（见 {INDEX_FILENAME}），本次跳过。"

        results: list[str] = []
        success = 0
        failed = 0
        for item in pending:
            file_path = item["file"]
            index = item["index"]
            index_dir = item["index_dir"]
            index_path = item["index_path"]
            print(f"[decrypt_qq] 开始处理: {file_path.name}")
            try:
                summary = adapter.decrypt_one(
                    file_path,
                    dst,
                    {"format_rules": {"mflac": "flac", "mgg": "m4a", "mmp4": "m4a"}},
                    log_dir=dst,
                )
                out_path = summary.get("output_path", "")
                container = summary.get("detected_container", "bin")
                if out_path:
                    results.append(f"  成功: {file_path.name} -> {out_path} [{container}]")
                    success += 1
                    print(f"[decrypt_qq] 成功: {file_path.name} -> {container}")
                    mark_processed(index, file_path, index_dir, str(out_path), container)
                    save_index(index_path, index)
                else:
                    results.append(f"  失败: {file_path.name} - 未识别的音频容器")
                    failed += 1
            except Exception as exc:
                results.append(f"  失败: {file_path.name} - {exc}")
                failed += 1
                print(f"[decrypt_qq] 失败: {file_path.name} - {exc}")

        header = f"解密完成：共 {len(pending)} 个待处理，成功 {success}，失败 {failed}，跳过 {len(skipped)}"
        print(f"[decrypt_qq] {header}")
        return header + "\n" + "\n".join(results)
    except Exception as exc:
        return f"解密失败：{exc}"


@tool
def decrypt_netease(input_path: str, output_dir: str) -> str:
    """解密网易云音乐加密文件（ncm 格式），输出为可播放的音频文件。无需运行网易云音乐客户端。

    Args:
        input_path: 加密文件或包含加密文件的目录路径
        output_dir: 解密后音频文件的输出目录
    """
    try:
        src = _to_path(input_path)
        dst = _to_path(output_dir)
        dst.mkdir(parents=True, exist_ok=True)

        if not src.exists():
            return f"错误：输入路径不存在 - {input_path}"

        print(f"[decrypt_netease] 输入: {src} | 输出: {dst}")
        try:
            from src.Infrastructure.platforms.registry import build_platform_adapter
        except ImportError as exc:
            return f"错误：网易云解密运行时不可用 - {exc}"

        adapter = build_platform_adapter("netease")
        ok, _reason = adapter.validate_runtime({})
        if not ok:
            return "错误：网易云解密运行时校验失败。"
        print("[decrypt_netease] 运行时校验通过")

        files_to_decrypt = adapter.collect_files(src, True)
        if not files_to_decrypt:
            return f"在 {input_path} 中未找到网易云音乐加密文件（ncm）"
        print(f"[decrypt_netease] 待解密文件 {len(files_to_decrypt)} 个")

        pending, skipped = plan_files(files_to_decrypt)
        if skipped:
            print(f"[decrypt_netease] 跳过已处理文件 {len(skipped)} 个（见 {INDEX_FILENAME}）")
        if not pending:
            return f"所有 {len(skipped)} 个文件均已处理过（见 {INDEX_FILENAME}），本次跳过。"

        results: list[str] = []
        success = 0
        failed = 0
        for item in pending:
            file_path = item["file"]
            index = item["index"]
            index_dir = item["index_dir"]
            index_path = item["index_path"]
            print(f"[decrypt_netease] 开始处理: {file_path.name}")
            try:
                summary = adapter.decrypt_one(file_path, dst, {}, log_dir=dst)
                out_path = summary.get("output_path", "")
                container = summary.get("detected_container", "bin")
                if out_path:
                    results.append(f"  成功: {file_path.name} -> {out_path} [{container}]")
                    success += 1
                    print(f"[decrypt_netease] 成功: {file_path.name} -> {container}")
                    mark_processed(index, file_path, index_dir, str(out_path), container)
                    save_index(index_path, index)
                else:
                    results.append(f"  失败: {file_path.name} - 未识别的音频容器")
                    failed += 1
            except Exception as exc:
                results.append(f"  失败: {file_path.name} - {exc}")
                failed += 1
                print(f"[decrypt_netease] 失败: {file_path.name} - {exc}")

        header = f"解密完成：共 {len(pending)} 个待处理，成功 {success}，失败 {failed}，跳过 {len(skipped)}"
        print(f"[decrypt_netease] {header}")
        return header + "\n" + "\n".join(results)
    except Exception as exc:
        return f"解密失败：{exc}"


@tool
def decrypt_kuwo(input_path: str, output_dir: str) -> str:
    """解密酷我音乐加密文件（kwm 格式），输出为可播放的音频文件。无需运行酷我音乐客户端。

    Args:
        input_path: 加密文件或包含加密文件的目录路径
        output_dir: 解密后音频文件的输出目录
    """
    try:
        from src.Infrastructure.platforms.kuwo.unlockmusic_decoder import decrypt_kwm_file

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
        if not files:
            return f"在 {input_path} 中未找到酷我音乐加密文件（kwm）"
        print(f"[decrypt_kuwo] 待解密文件 {len(files)} 个")

        pending, skipped = plan_files(files)
        if skipped:
            print(f"[decrypt_kuwo] 跳过已处理文件 {len(skipped)} 个（见 {INDEX_FILENAME}）")
        if not pending:
            return f"所有 {len(skipped)} 个文件均已处理过（见 {INDEX_FILENAME}），本次跳过。"

        results: list[str] = []
        success = 0
        failed = 0
        for item in pending:
            file_path = item["file"]
            index = item["index"]
            index_dir = item["index_dir"]
            index_path = item["index_path"]
            print(f"[decrypt_kuwo] 开始处理: {file_path.name}")
            try:
                out_base = dst / file_path.stem
                final_path, ext = decrypt_kwm_file(file_path, out_base)
                results.append(f"  成功: {file_path.name} -> {final_path} [{ext}]")
                success += 1
                print(f"[decrypt_kuwo] 成功: {file_path.name} -> {ext}")
                mark_processed(index, file_path, index_dir, str(final_path), ext)
                save_index(index_path, index)
            except Exception as exc:
                results.append(f"  失败: {file_path.name} - {exc}")
                failed += 1
                print(f"[decrypt_kuwo] 失败: {file_path.name} - {exc}")

        header = f"解密完成：共 {len(pending)} 个待处理，成功 {success}，失败 {failed}，跳过 {len(skipped)}"
        print(f"[decrypt_kuwo] {header}")
        return header + "\n" + "\n".join(results)
    except Exception as exc:
        return f"解密失败：{exc}"


@tool
def transcode_audio(input_path: str, target_format: str, output_dir: str = "") -> str:
    """将音频文件用 ffmpeg 转换为目标格式（mp3/m4a/flac/wav）。输入可以是单个文件或目录，会原地替换或输出到指定目录。

    Args:
        input_path: 源音频文件或目录路径
        target_format: 目标格式，可选 mp3/m4a/flac/wav
        output_dir: 可选输出目录，留空则输出到源文件同目录
    """
    try:
        from src.Infrastructure.transcoder import (
            SUPPORTED_TARGET_FORMATS,
            normalize_target_format,
            transcode_file,
        )

        src = _to_path(input_path)
        if not src.exists():
            return f"错误：输入路径不存在 - {input_path}"

        fmt = normalize_target_format(target_format)
        if fmt == "auto":
            return "错误：目标格式必须明确指定（mp3/m4a/flac/wav），不接受 auto。"

        dst_root = _to_path(output_dir) if output_dir.strip() else (src.parent if src.is_file() else src)
        dst_root.mkdir(parents=True, exist_ok=True)
        print(f"[transcode_audio] 输入: {src} | 目标格式: {fmt} | 输出: {dst_root}")

        files = [src] if src.is_file() else sorted(p for p in src.rglob("*") if p.is_file())
        audio_exts = {".flac", ".mp3", ".m4a", ".wav", ".ogg", ".aac"}
        targets = [p for p in files if p.suffix.lower() in audio_exts]
        if not targets:
            return f"未找到可转换的音频文件（支持 flac/mp3/m4a/wav/ogg/aac）"
        print(f"[transcode_audio] 待转换文件 {len(targets)} 个")

        results: list[str] = []
        success = 0
        failed = 0
        skipped = 0
        for file_path in targets:
            out_name = f"{file_path.stem}.{fmt}"
            # 目录输入时若指定了 output_dir 则统一写到 dst_root，否则写回源文件所在目录
            out_dir = dst_root if (output_dir.strip() or src.is_file()) else file_path.parent
            out_path = out_dir / out_name
            if out_path == file_path:
                results.append(f"  跳过: {file_path.name} - 目标格式与原文件相同，不覆盖原文件")
                skipped += 1
                print(f"[transcode_audio] 跳过: {file_path.name} - 同扩展名")
                continue
            if out_path.exists():
                out_path = out_path.with_name(f"{file_path.stem}_converted.{fmt}")
                print(f"[transcode_audio] 重命名以避免覆盖: {out_path.name}")
            print(f"[transcode_audio] 开始: {file_path.name} -> {fmt}")
            try:
                info = transcode_file(file_path, out_path, fmt)
                results.append(f"  成功: {file_path.name} -> {info.get('output_path', out_path)}")
                success += 1
            except Exception as exc:
                results.append(f"  失败: {file_path.name} - {exc}")
                failed += 1
                print(f"[transcode_audio] 失败: {file_path.name} - {exc}")

        header = f"转换完成：共 {len(targets)} 个文件，成功 {success}，失败 {failed}，跳过 {skipped}"
        print(f"[transcode_audio] {header}")
        return header + "\n" + "\n".join(results)
    except ValueError as exc:
        return f"错误：{exc}"
    except FileNotFoundError as exc:
        return f"错误：{exc}"
    except Exception as exc:
        return f"转换失败：{exc}"


@tool
def verify_audio_integrity(input_path: str) -> str:
    """校验音频文件是否完整可播放。通过容器探测、流信息分析判断文件是否损坏。完成解密或格式转换后应调用本工具确认结果。

    Args:
        input_path: 单个音频文件路径或包含音频文件的目录
    """
    try:
        from src.Infrastructure.transcoder import detect_audio_container, probe_media_summary, summary_to_log

        src = _to_path(input_path)
        if not src.exists():
            return f"错误：输入路径不存在 - {input_path}"

        files = [src] if src.is_file() else sorted(p for p in src.rglob("*") if p.is_file())
        audio_exts = {".flac", ".mp3", ".m4a", ".wav", ".ogg", ".aac", ".bin"}
        targets = [p for p in files if p.suffix.lower() in audio_exts]
        if not targets:
            return f"未发现音频文件（支持 flac/mp3/m4a/wav/ogg/aac）"

        print(f"[verify_audio_integrity] 待校验 {len(targets)} 个文件")
        results: list[str] = []
        ok_count = 0
        broken_count = 0
        for file_path in targets:
            try:
                container, stage = detect_audio_container(file_path)
                summary = probe_media_summary(file_path)
                audio_streams = int(summary.get("audio_streams", 0) or 0)
                size = file_path.stat().st_size
                if container == "bin" or audio_streams < 1 or size < 1024:
                    results.append(f"  损坏: {file_path.name} - container={container} audio_streams={audio_streams} size={size}")
                    broken_count += 1
                    print(f"[verify_audio_integrity] 损坏: {file_path.name}")
                else:
                    results.append(f"  正常: {file_path.name} - {summary_to_log(summary)}")
                    ok_count += 1
                    print(f"[verify_audio_integrity] 正常: {file_path.name} [{container}]")
            except Exception as exc:
                results.append(f"  损坏: {file_path.name} - {exc}")
                broken_count += 1
                print(f"[verify_audio_integrity] 异常: {file_path.name} - {exc}")

        header = f"校验完成：共 {len(targets)} 个文件，正常 {ok_count}，损坏 {broken_count}"
        print(f"[verify_audio_integrity] {header}")
        return header + "\n" + "\n".join(results)
    except Exception as exc:
        return f"校验失败：{exc}"


@tool
def copy_files(source_dir: str, target_dir: str, file_extensions: str = "") -> str:
    """将文件从源目录复制到目标目录（保留源文件），可选按扩展名过滤。

    Args:
        source_dir: 源目录路径
        target_dir: 目标目录路径
        file_extensions: 扩展名过滤，逗号分隔（如 ".flac,.m4a"），为空则复制所有文件
    """
    try:
        src = _to_path(source_dir)
        dst = _to_path(target_dir)
        dst.mkdir(parents=True, exist_ok=True)

        if not src.exists():
            return f"错误：源目录不存在 - {source_dir}"

        extensions = set()
        if file_extensions.strip():
            extensions = {ext.strip().lower() for ext in file_extensions.split(",")}

        count = 0
        for item in src.iterdir():
            if not item.is_file():
                continue
            if extensions and item.suffix.lower() not in extensions:
                continue
            target = dst / item.name
            if target.exists():
                target.unlink()
            shutil.copy2(str(item), str(target))
            count += 1

        return f"已复制 {count} 个文件从 {source_dir} 到 {target_dir}"
    except Exception as exc:
        return f"复制文件失败：{exc}"


@tool
def move_files(source_dir: str, target_dir: str, file_extensions: str = "") -> str:
    """将文件从源目录移动到目标目录（不保留源文件），可选按扩展名过滤。

    Args:
        source_dir: 源目录路径
        target_dir: 目标目录路径
        file_extensions: 扩展名过滤，逗号分隔（如 ".flac,.ogg"），为空则移动所有文件
    """
    try:
        src = _to_path(source_dir)
        dst = _to_path(target_dir)
        dst.mkdir(parents=True, exist_ok=True)

        if not src.exists():
            return f"错误：源目录不存在 - {source_dir}"

        extensions = set()
        if file_extensions.strip():
            extensions = {ext.strip().lower() for ext in file_extensions.split(",")}

        count = 0
        for item in src.iterdir():
            if not item.is_file():
                continue
            if extensions and item.suffix.lower() not in extensions:
                continue
            target = dst / item.name
            if target.exists():
                target.unlink()
            shutil.move(str(item), str(target))
            count += 1

        ext_info = f"（扩展名过滤: {file_extensions}）" if file_extensions.strip() else "（所有文件）"
        return f"已移动 {count} 个文件从 {source_dir} 到 {target_dir}{ext_info}"
    except Exception as exc:
        return f"移动文件失败：{exc}"


@tool
def rename_file(file_path: str, new_name: str) -> str:
    """重命名单个文件，文件保持在原目录不变。

    Args:
        file_path: 源文件路径
        new_name: 新文件名（不含目录路径，如 "新名字.mp3"）
    """
    try:
        src = _to_path(file_path)
        if not src.exists() or not src.is_file():
            return f"错误：源文件不存在或不是文件 - {file_path}"
        new_name_clean = pathlib.PurePath(new_name).name
        if not new_name_clean or new_name_clean in (".", ".."):
            return f"错误：新文件名无效 - {new_name}"
        target = src.parent / new_name_clean
        if target == src:
            return f"新文件名与原文件名相同，无需重命名 - {src.name}"
        if target.exists():
            return f"错误：目标文件已存在 - {target}"
        src.rename(target)
        print(f"[rename_file] {src.name} -> {target.name}")
        return f"已重命名: {src.name} -> {target}"
    except Exception as exc:
        return f"重命名失败：{exc}"


def _coerce_cli_args(value: Any) -> Any:
    """兼容 LLM 把 list 参数序列化成 JSON 字符串传入的情况。"""
    if value is None:
        return None
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        # 优先尝试 JSON 解析（LLM 常把 ['a','b'] 传成 '["a","b"]'）
        if stripped[0] in "[{":
            try:
                import json
                parsed = json.loads(stripped)
                if isinstance(parsed, list):
                    return [str(x) for x in parsed]
            except Exception:
                pass
        # 单参数兜底
        return [stripped]
    if isinstance(value, (list, tuple)):
        return [str(x) for x in value]
    return [str(value)]


_CliArgs = Annotated[list[str] | None, BeforeValidator(_coerce_cli_args)]


# 安全命令白名单：低风险，可在所有模式下直接执行
_SAFE_CLI_COMMANDS: set[str] = {
    "ffmpeg",
    "ffprobe",
    "python",
    "python3",
    "dir",
    "ls",
    "type",
    "echo",
    "file",
    "magick",
    "convert",
}

# 危险命令白名单：高风险，在标准模式下需要用户确认，完全访问模式下直接执行
_DANGEROUS_CLI_COMMANDS: set[str] = {
    "cmd",
    "copy",
    "move",
    "mkdir",
    "rmdir",
    "del",
}

# 完整白名单（安全 + 危险）
_ALLOWED_CLI_COMMANDS = _SAFE_CLI_COMMANDS | _DANGEROUS_CLI_COMMANDS

# 全局权限模式存储（使用全局变量而非 threading.local，因为工具调用可能跨线程）
_permission_mode: str = "standard"


@tool
def run_cli_safely(command: str, cli_args: _CliArgs = None, cwd: str = "") -> str:
    """安全执行命令行程序，统一处理中文路径与编码问题。需要调用外部命令（如 ffmpeg、脚本）时必须使用本工具。

    权限模式说明：
    - 完全访问模式（full）：所有白名单命令直接执行，无需确认
    - 标准模式（standard）：危险命令（cmd/copy/del/rmdir 等）需要用户确认
    - 受限模式（restricted）：危险命令被拒绝

    Args:
        command: 可执行程序名或路径（如 "ffmpeg" 或 "python"）
        cli_args: 参数列表，每个元素单独一项；含中文或空格的路径直接作为列表元素传入，不要手动拼接引号
        cwd: 可选工作目录，留空则在当前目录执行
    """
    try:
        import subprocess

        cmd_list = [command]
        for a in (cli_args or []):
            if isinstance(a, (list, tuple)):
                cmd_list.extend(str(x) for x in a)
            else:
                cmd_list.append(str(a))
        if not cmd_list[0]:
            return "错误：command 不能为空"

        # 提取基本命令名（去掉路径），转小写用于白名单匹配
        cmd_basename = pathlib.Path(cmd_list[0]).name.lower()
        permission_mode = _get_permission_mode()

        # 检查命令是否在白名单中
        if cmd_basename not in _ALLOWED_CLI_COMMANDS:
            # 非白名单命令：根据权限模式决定
            if permission_mode == "restricted":
                print(f"[run_cli_safely] 受限模式，拒绝执行非白名单命令: {cmd_basename}")
                return f"受限模式下不允许执行非白名单命令：{cmd_basename}，请切换到标准或完全访问模式。"
            # standard/full 模式：LLM 已决定调用此命令，信任其判断（不再弹窗询问）
            print(f"[run_cli_safely] {'标准' if permission_mode == 'standard' else '完全访问'}模式，LLM 自授权执行非白名单命令: {cmd_basename}")
        elif cmd_basename in _DANGEROUS_CLI_COMMANDS:
            # 危险命令：根据权限模式决定
            if permission_mode == "restricted":
                print(f"[run_cli_safely] 受限模式，拒绝执行危险命令: {cmd_basename}")
                return f"受限模式下不允许执行危险命令：{cmd_basename}，请切换到标准或完全访问模式。"
            # standard/full 模式：LLM 自授权执行（不再弹窗询问）
            print(f"[run_cli_safely] {'标准' if permission_mode == 'standard' else '完全访问'}模式，LLM 自授权执行危险命令: {cmd_basename}")

        work_dir = str(pathlib.Path(cwd).resolve()) if cwd.strip() else None
        print(f"[run_cli_safely] cmd={cmd_list} cwd={work_dir} mode={permission_mode}")

        # 加 -nostdin 防止命令等待 stdin 挂起（ffmpeg 常见陷阱）
        if "-nostdin" not in cmd_list and cmd_list[0].lower().endswith(("ffmpeg", "ffmpeg.exe", "ffprobe", "ffprobe.exe")):
            cmd_list = [cmd_list[0], "-nostdin", *cmd_list[1:]]

        timeout = 300  # 与 transcoder._run_ffmpeg_safely 保持一致
        try:
            completed = subprocess.run(
                cmd_list,
                shell=False,
                cwd=work_dir,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout,
            )
        except subprocess.TimeoutExpired as exc:
            # 超时强制清理整个进程树（Windows taskkill /F /T）
            if os.name == "nt":
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(exc.pid)], capture_output=True, errors="replace")
            print(f"[run_cli_safely] 超时 ({timeout}s) 强制终止: {cmd_list}")
            return f"命令执行超时 ({timeout}s)，已强制终止"

        stdout = (completed.stdout or "")
        stderr = (completed.stderr or "")
        print(f"[run_cli_safely] returncode={completed.returncode}")
        result = f"退出码: {completed.returncode}\n--- stdout ---\n{stdout}"
        if stderr:
            result += f"\n--- stderr ---\n{stderr}"
        return result
    except FileNotFoundError as exc:
        return f"错误：命令未找到 - {exc}"
    except Exception as exc:
        return f"命令执行失败：{exc}"


@tool
def rag_retrieve(query: str, top_k: int = 4) -> str:
    """在本地知识库检索与问题相关的已沉淀解决方案/经验。

    Args:
        query: 要检索的问题或关键词（自然语言即可）
        top_k: 返回的最相关条目数，默认 4
    """
    try:
        from src.Infrastructure.rag.seed import ensure_seeded
        from src.Infrastructure.rag.store import query_similar

        ensure_seeded()
        hits = query_similar(query, top_k=max(1, int(top_k)))
        if not hits:
            return "知识库为空，暂无相关记录。"
        lines = [f"检索到 {len(hits)} 条相关知识："]
        for idx, h in enumerate(hits, 1):
            score = round(float(h.get("score", 0.0)), 3)
            source = h.get("source") or "未知"
            text = str(h.get("text", "")).strip()
            lines.append(f"\n[{idx}] (相关度 {score}) 来源: {source}\n{text}")
        print(f"[rag_retrieve] query={query[:60]} -> {len(hits)} 条")
        return "\n".join(lines)
    except Exception as exc:
        return f"知识库检索失败：{exc}"


@tool
def rag_ingest(text: str, source: str = "agent") -> str:
    """把一条经验/解决方案写入本地知识库，便于后续检索复用。

    Args:
        text: 要沉淀的知识内容（自然语言描述的方案/经验）
        source: 来源标识，如 "agent"、"用户补充"、"调试经验"
    """
    try:
        from src.Infrastructure.rag.store import upsert_document

        if not text.strip():
            return "错误：内容不能为空"
        doc_id = upsert_document(text=text.strip(), source=source or "agent")
        print(f"[rag_ingest] 写入 id={doc_id} source={source} len={len(text)}")
        return f"已写入知识库: id={doc_id} 来源={source}"
    except Exception as exc:
        return f"知识库写入失败：{exc}"


@tool
def detect_format(file_path: str) -> str:
    """检测音频文件的容器格式（flac/mp3/m4a/wav/ogg/bin）。

    Args:
        file_path: 音频文件路径
    """
    try:
        path = _to_path(file_path)
        if not path.exists():
            return f"错误：文件不存在 - {file_path}"

        with path.open("rb") as f:
            head = f.read(64)

        container = detect_extension(head, "bin")
        size = path.stat().st_size

        return f"文件: {path.name}\n大小: {size} bytes\n容器格式: {container}\n文件头 (hex): {head[:32].hex()}"
    except Exception as exc:
        return f"检测失败：{exc}"


@tool
def list_directory(directory: str, show_hidden: bool = False) -> str:
    """列出指定目录下的所有文件和子目录。

    Args:
        directory: 目录路径
        show_hidden: 是否显示隐藏文件，默认为 False
    """
    try:
        path = _to_path(directory)
        if not path.exists():
            return f"错误：目录不存在 - {directory}"
        if not path.is_dir():
            return f"错误：路径不是目录 - {directory}"

        entries = sorted(path.iterdir(), key=lambda x: (x.is_file(), x.name.lower()))
        if not show_hidden:
            entries = [e for e in entries if not e.name.startswith(".")]

        if not entries:
            return f"目录 {directory} 为空"

        lines = [f"目录 {directory} 包含 {len(entries)} 个条目:"]
        for entry in entries:
            prefix = "[DIR] " if entry.is_dir() else "[FILE]"
            size = f"{entry.stat().st_size} bytes" if entry.is_file() else ""
            lines.append(f"  {prefix} {entry.name} {size}".strip())

        return "\n".join(lines)
    except Exception as exc:
        return f"列出目录失败：{exc}"


@tool
def ask_user(question: str, options: list[str]) -> str:
    """遇到不确定的操作时询问用户如何处理。调用后会弹出对话框等待用户选择，返回用户所选内容。

    使用时机（必须调用本工具而非自行假设）：
    - _processed_index.json 标记文件已处理，但目标输出目录为空（用户可能已删除输出文件或想重新处理）
    - 目标路径已存在同名文件，覆盖/跳过/重命名无法判断用户意图
    - 工具返回多种恢复路径，无法确定用户偏好

    Args:
        question: 向用户提出的清晰问题（一句话，包含足够上下文让用户能做决定）
        options: 2~4 个互斥选项字符串，每个选项是一条明确的可执行动作描述
    """
    print(f"[ask_user] question={question[:80]} options={options}")
    callback = _get_ask_user_callback()
    if callback is None:
        return "错误：ask_user 回调未注入（worker 未启动）"
    if not question.strip():
        return "错误：question 不能为空"
    clean_options = [str(o).strip() for o in options if str(o).strip()]
    if len(clean_options) < 2:
        return "错误：options 至少需要 2 个有效选项"
    try:
        answer = callback(question, clean_options)
        print(f"[ask_user] 用户选择: {answer}")
        return f"用户选择：{answer}"
    except Exception as exc:
        print(f"[ask_user] 异常: {exc}")
        return f"询问用户失败：{exc}"


def _safe_tool_name(tool: object) -> str:
    try:
        name = getattr(tool, "name", None)
        if name and isinstance(name, str):
            return name
    except Exception:
        pass
    try:
        name = getattr(tool, "tool_name", None)
        if name and isinstance(name, str):
            return name
    except Exception:
        pass
    try:
        fn = getattr(tool, "func", None)
        if fn and hasattr(fn, "__name__"):
            return fn.__name__
    except Exception:
        pass
    return getattr(tool, "__name__", "unknown")


@tool
def sandbox_manage(action: str, path: str = "") -> str:
    """管理文件操作沙箱：授权/取消授权目录、查看当前授权目录。

    沙箱限制所有文件操作必须在授权目录范围内。支持的操作：
    - "status": 查看当前沙箱状态和授权目录
    - "add": 授权一个目录（path 参数必填）
    - "remove": 取消授权一个目录（path 参数必填）
    - "clear": 清空所有授权目录
    - "enable": 启用沙箱
    - "disable": 禁用沙箱（临时放行所有路径）

    Args:
        action: 操作类型：status / add / remove / clear / enable / disable
        path: 目录路径（add/remove 操作必填）
    """
    try:
        sandbox = get_sandbox()
        action_lower = action.strip().lower()

        if action_lower == "status":
            status = sandbox.get_status()
            paths = status["authorized_paths"]
            paths_str = "\n".join(f"  - {p}" for p in paths) if paths else "  （无）"
            return (
                f"沙箱状态:\n"
                f"  启用: {'是' if status['enabled'] else '否'}\n"
                f"  授权目录数: {status['paths_count']}\n"
                f"  授权目录:\n{paths_str}"
            )

        elif action_lower == "add":
            if not path.strip():
                return "错误: add 操作需要指定 path 参数"
            added = sandbox.add_path(path)
            if added:
                return f"已授权目录: {path}"
            return f"目录已在授权范围内: {path}（无需重复授权）"

        elif action_lower == "remove":
            if not path.strip():
                return "错误: remove 操作需要指定 path 参数"
            if sandbox.remove_path(path):
                return f"已取消授权: {path}"
            return f"目录不在授权列表中: {path}"

        elif action_lower == "clear":
            sandbox.clear()
            return "已清空所有授权目录"

        elif action_lower == "enable":
            sandbox.enabled = True
            return "沙箱已启用"

        elif action_lower == "disable":
            sandbox.enabled = False
            return "沙箱已禁用（所有路径均可操作）"

        else:
            return f"未知操作: {action}，支持的操作: status, add, remove, clear, enable, disable"

    except PermissionError as exc:
        return f"权限错误: {exc}"
    except ValueError as exc:
        return f"参数错误: {exc}"
    except Exception as exc:
        return f"沙箱操作失败: {exc}"


ALL_TOOLS = [
    scan_files,
    decrypt_kugou,
    decrypt_qq,
    decrypt_netease,
    decrypt_kuwo,
    copy_files,
    move_files,
    rename_file,
    run_cli_safely,
    transcode_audio,
    verify_audio_integrity,
    detect_format,
    rag_retrieve,
    rag_ingest,
    list_directory,
    ask_user,
    sandbox_manage,
]
TOOL_NAMES = [_safe_tool_name(t) for t in ALL_TOOLS]
