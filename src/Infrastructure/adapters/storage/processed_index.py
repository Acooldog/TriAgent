"""加密文件已处理记录索引（_processed_index.json）。

按文件所在目录维护 JSON，记录已解密的加密文件（路径+大小+mtime），避免重复解密。
首次处理时新建 JSON；后续每次解密前复查，排除已记录的文件。
"""
from __future__ import annotations

import datetime
import json
import os
import pathlib
import tempfile

INDEX_FILENAME = "_processed_index.json"
MTIME_TOLERANCE = 1.0  # 兼容文件系统时间精度差异


def index_path_for(file_path: pathlib.Path) -> pathlib.Path:
    return file_path.parent / INDEX_FILENAME


def load_index(index_path: pathlib.Path) -> dict:
    if not index_path.exists():
        return {"files": []}
    try:
        data = json.loads(index_path.read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("files"), list):
            return data
    except Exception:
        pass
    return {"files": []}


def save_index(index_path: pathlib.Path, index: dict) -> None:
    """原子写入索引文件：先写临时文件，再 rename 覆盖，避免中途崩溃导致数据损坏。"""
    index_path.parent.mkdir(parents=True, exist_ok=True)
    content = json.dumps(index, ensure_ascii=False, indent=2)
    # 在同目录创建临时文件，确保 rename 是原子操作
    fd, tmp_path = tempfile.mkstemp(
        prefix=INDEX_FILENAME + ".",
        suffix=".tmp",
        dir=str(index_path.parent),
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as tmp_file:
            tmp_file.write(content)
            tmp_file.flush()
            os.fsync(tmp_file.fileno())  # 确保落盘
        os.replace(tmp_path, str(index_path))  # 原子替换
    except Exception:
        # 清理临时文件
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def _relative_to(file_path: pathlib.Path, index_dir: pathlib.Path) -> str:
    try:
        return file_path.relative_to(index_dir).as_posix()
    except ValueError:
        return file_path.name


def is_processed(
    index: dict,
    file_path: pathlib.Path,
    index_dir: pathlib.Path,
    output_dir: str | None = None,
    target_format: str | None = None,
) -> bool:
    """检查文件是否已被处理过。

    去重维度：rel + size + mtime + output_dir + target_format(container)。
    只有输出目录和目标格式都匹配时才视为已处理。任一维度不同 → 允许重新解密。
    如果索引记录的输出文件已被删除，也视为未处理（支持用户做实验时手动清理输出）。

    Args:
        output_dir: 本次调用的输出目录（绝对路径字符串）。
        target_format: 本次调用的目标输出格式，如 "m4a"、"flac"、"mp3"。
                       与 index 记录的 container 比较。
    """
    rel = _relative_to(file_path, index_dir)
    try:
        stat = file_path.stat()
    except OSError:
        return False
    for rec in index.get("files", []):
        if not (
            rec.get("rel") == rel
            and rec.get("size") == stat.st_size
            and abs(rec.get("mtime", 0) - stat.st_mtime) < MTIME_TOLERANCE
        ):
            continue
        # 基础去重 key 匹配 → 进一步检查输出目录和目标格式
        if output_dir is not None:
            existing_output = rec.get("output_path", "")
            existing_parent = str(pathlib.Path(existing_output).parent) if existing_output else ""
            try:
                same_dir = pathlib.Path(existing_parent).resolve() == pathlib.Path(output_dir).resolve()
            except OSError:
                same_dir = existing_parent == output_dir
            if not same_dir:
                return False  # 输出目录不同 → 未处理
        if target_format is not None:
            existing_container = str(rec.get("container", "")).lower().lstrip(".")
            if existing_container and existing_container != target_format.lower().lstrip("."):
                return False  # 目标格式不同 → 未处理
        # 检查输出文件是否还存在（用户可能已删除做实验）
        existing_output = rec.get("output_path", "")
        if existing_output:
            try:
                if not pathlib.Path(existing_output).exists():
                    return False  # 输出文件已被删除 → 视为未处理
            except OSError:
                return False
        return True
    return False


def mark_processed(
    index: dict,
    file_path: pathlib.Path,
    index_dir: pathlib.Path,
    output_path: str,
    container: str,
) -> None:
    rel = _relative_to(file_path, index_dir)
    try:
        stat = file_path.stat()
    except OSError:
        return
    index.setdefault("files", []).append({
        "rel": rel,
        "size": stat.st_size,
        "mtime": stat.st_mtime,
        "output_path": output_path,
        "container": container,
        "at": datetime.datetime.now().isoformat(timespec="seconds"),
    })


def plan_files(
    files: list[pathlib.Path],
    output_dir: str | None = None,
    target_format: str | None = None,
) -> tuple[list[dict], list[pathlib.Path]]:
    """按文件所在目录分组，加载各自 index，返回 (pending, skipped)。

    去重维度：rel + size + mtime + output_dir + target_format。
    任一维度不同 → 允许重新解密。

    Args:
        output_dir: 本次调用的输出目录。
        target_format: 本次调用的目标输出格式（如 "m4a"、"flac"、"mp3"）。
                       会与已记录的 container 字段比较。

    pending 项: {"file", "index_dir", "index_path", "index"}
    skipped: 已在 index 中记录的文件列表
    """
    pending: list[dict] = []
    skipped: list[pathlib.Path] = []
    groups: dict[pathlib.Path, list[pathlib.Path]] = {}
    for f in files:
        groups.setdefault(f.parent, []).append(f)
    for index_dir, group_files in groups.items():
        idx_path = index_path_for(group_files[0])
        idx = load_index(idx_path)
        for f in group_files:
            if is_processed(idx, f, index_dir, output_dir=output_dir, target_format=target_format):
                skipped.append(f)
            else:
                pending.append({
                    "file": f,
                    "index_dir": index_dir,
                    "index_path": idx_path,
                    "index": idx,
                })
    return pending, skipped
