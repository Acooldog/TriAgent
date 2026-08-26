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


def is_processed(index: dict, file_path: pathlib.Path, index_dir: pathlib.Path) -> bool:
    rel = _relative_to(file_path, index_dir)
    try:
        stat = file_path.stat()
    except OSError:
        return False
    for rec in index.get("files", []):
        if (
            rec.get("rel") == rel
            and rec.get("size") == stat.st_size
            and abs(rec.get("mtime", 0) - stat.st_mtime) < MTIME_TOLERANCE
        ):
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


def plan_files(files: list[pathlib.Path]) -> tuple[list[dict], list[pathlib.Path]]:
    """按文件所在目录分组，加载各自 index，返回 (pending, skipped)。

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
            if is_processed(idx, f, index_dir):
                skipped.append(f)
            else:
                pending.append({
                    "file": f,
                    "index_dir": index_dir,
                    "index_path": idx_path,
                    "index": idx,
                })
    return pending, skipped
