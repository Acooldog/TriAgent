from __future__ import annotations

import os
import pathlib
import shutil
from typing import Any

from src.Infrastructure.config_repository import auto_find_kgg_db_path, auto_find_kugou_key
from src.Infrastructure.file_catalog import SUPPORTED_SUFFIXES, iter_supported_files
from src.Infrastructure.kugou_decoder import (
    DEFAULT_KGG_DB_PATH,
    DEFAULT_KEY_PATH,
    decode_file,
    detect_extension,
)
from src.Infrastructure.runtime_paths import RuntimePaths

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

PATHS = RuntimePaths.discover()

TOOL_DESCRIPTIONS = {
    "scan_files": "扫描指定目录下的加密音乐文件（支持 kgma/kgm/kgg/vpr 格式），返回找到的文件列表和数量。",
    "decrypt_kugou": "解密酷狗音乐加密文件（kgma、kgm、kgg、vpr 等格式），输出为可播放的音频文件。使用 UnlockMusic 完整解密算法。",
    "move_files": "将文件从源路径复制或移动到目标目录，保持文件名不变。支持批量操作。",
    "detect_format": "检测音频文件的容器格式（flac/mp3/m4a/wav/ogg 等），通过读取文件头特征判断。",
    "list_directory": "列出指定目录下的所有文件和子目录，返回文件名称列表。",
}

def _find_kugou_key() -> pathlib.Path | None:
    key = auto_find_kugou_key(PATHS)
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
        file_types: 文件类型过滤，目前支持 "kugou"（酷狗格式）
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
    """解密酷狗音乐加密文件（kgma/kgm/kgg/vpr）。使用 UnlockMusic 完整解密算法。

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

        results = []
        success = 0
        failed = 0

        for file_path in files_to_decrypt:
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
                else:
                    results.append(f"  失败: {file_path.name} - 未识别的音频容器")
                    failed += 1
            except Exception as exc:
                results.append(f"  失败: {file_path.name} - {exc}")
                failed += 1

        header = f"解密完成：共 {len(files_to_decrypt)} 个文件，成功 {success}，失败 {failed}"
        return header + "\n" + "\n".join(results)
    except Exception as exc:
        return f"解密失败：{exc}"


@tool
def move_files(source_dir: str, target_dir: str, file_extensions: str = "") -> str:
    """将文件从源目录复制到目标目录，可选按扩展名过滤。

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
        return f"移动文件失败：{exc}"


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


ALL_TOOLS = [scan_files, decrypt_kugou, move_files, detect_format, list_directory]
TOOL_NAMES = [_safe_tool_name(t) for t in ALL_TOOLS]
