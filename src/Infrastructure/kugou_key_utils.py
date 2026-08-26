from __future__ import annotations

import hashlib
import lzma
import os
import pathlib
from typing import Callable

from src.Infrastructure.runtime_paths import RuntimePaths

# ---------------------------------------------------------------------------
# Constants shared with kugou_key_refresh
# ---------------------------------------------------------------------------

LOCAL_SCAN_FILENAMES = (
    "kugou_key_refreshed.xz",
    "kugou_key.xz",
    "kg_key.xz",
    "kugoukey.xz",
)
LOCAL_SCAN_DIR_PATTERNS = ("KuGou8", "KuGou", "KG")
LOCAL_SCAN_EXTRA_EXTENSIONS = ("*.xz",)
LOCAL_CONTAINER_HINTS = ("AppStore", "OfflinePackage")
MAX_LOCAL_SCAN_DEPTH = 3
MAX_LOCAL_CONTAINER_FILES = 12
MAX_LOCAL_CONTAINER_SIZE = 16 * 1024 * 1024
LOCAL_SOURCE_TIME_BUDGET_SEC = 5.0
XZ_MAGIC = bytes.fromhex("FD377A585A00")


def _iter_local_base_dirs() -> list[pathlib.Path]:
    roots: list[pathlib.Path] = []
    seen: set[str] = set()
    for raw_root in (os.environ.get("APPDATA"), os.environ.get("LOCALAPPDATA"), os.environ.get("PROGRAMDATA")):
        if not raw_root:
            continue
        root = pathlib.Path(raw_root)
        for pattern in LOCAL_SCAN_DIR_PATTERNS:
            direct = root / pattern
            wildcard_parent = root
            if direct.exists():
                key = str(direct.resolve()).lower()
                if key not in seen:
                    seen.add(key)
                    roots.append(direct.resolve())
            try:
                for matched in wildcard_parent.glob(f"{pattern}*"):
                    if matched.exists() and matched.is_dir():
                        key = str(matched.resolve()).lower()
                        if key not in seen:
                            seen.add(key)
                            roots.append(matched.resolve())
            except OSError:
                pass
    return roots


def _collect_local_candidates(base_dir: pathlib.Path, add: Callable[[pathlib.Path | None], None]) -> None:
    if not base_dir.exists() or not base_dir.is_dir():
        return
    for ext_pattern in LOCAL_SCAN_EXTRA_EXTENSIONS:
        try:
            for path in base_dir.glob(ext_pattern):
                add(path)
        except OSError:
            pass
    frontier = [(base_dir, 0)]
    while frontier:
        current, depth = frontier.pop(0)
        if depth >= MAX_LOCAL_SCAN_DEPTH:
            continue
        try:
            children = list(current.iterdir())
        except OSError:
            continue
        for child in children:
            if child.is_dir():
                frontier.append((child, depth + 1))
                for filename in LOCAL_SCAN_FILENAMES:
                    add(child / filename)
                for ext_pattern in LOCAL_SCAN_EXTRA_EXTENSIONS:
                    try:
                        for path in child.glob(ext_pattern):
                            add(path)
                    except OSError:
                        pass


def _iter_local_kugou_key_candidates(destination: pathlib.Path) -> list[pathlib.Path]:
    candidates: list[pathlib.Path] = []
    seen: set[str] = set()

    def add(path: pathlib.Path | None) -> None:
        if path is None:
            return
        try:
            resolved = path.expanduser().resolve()
        except OSError:
            return
        key = str(resolved).lower()
        if key in seen or not resolved.is_file() or resolved == destination:
            return
        seen.add(key)
        candidates.append(resolved)

    for base_dir in _iter_local_base_dirs():
        for filename in LOCAL_SCAN_FILENAMES:
            add(base_dir / filename)
        _collect_local_candidates(base_dir, add)
    return candidates


def _iter_local_container_candidates() -> list[pathlib.Path]:
    candidates: list[pathlib.Path] = []
    seen: set[str] = set()

    def add(path: pathlib.Path | None) -> None:
        if path is None:
            return
        try:
            resolved = path.expanduser().resolve()
        except OSError:
            return
        if not resolved.is_file():
            return
        try:
            size = resolved.stat().st_size
        except OSError:
            return
        if size <= 0 or size > MAX_LOCAL_CONTAINER_SIZE:
            return
        key = str(resolved).lower()
        if key in seen:
            return
        seen.add(key)
        candidates.append(resolved)

    for base_dir in _iter_local_base_dirs():
        if not base_dir.exists() or not base_dir.is_dir():
            continue
        direct_candidates = [
            base_dir / 'AppStore' / 'webgl' / 'v3.4' / 'snapshot_blob.bin',
            base_dir / 'AppStore' / 'webgl' / 'v3.4' / 'v8_context_snapshot.bin',
            base_dir / 'AppStore' / 'webgl' / 'v3.4' / 'icudtl.dat',
            base_dir / 'AppStore' / 'webgl' / 'v3.4' / 'external.bin',
            base_dir / 'AppStore' / 'webgl' / 'v3.4' / 'desktop_manager' / '32' / 'icudtl_infra.dat',
            base_dir / 'AppStore' / 'webgl' / 'v3.4' / 'desktop_manager' / '64' / 'icudtl_infra.dat',
        ]
        for candidate in direct_candidates:
            add(candidate)
    return candidates[:MAX_LOCAL_CONTAINER_FILES]


# ---------------------------------------------------------------------------
# xz validation helpers
# ---------------------------------------------------------------------------

def _extract_valid_xz_stream(payload: bytes) -> tuple[bytes, int]:
    if not payload:
        raise RuntimeError("Empty payload")
    decompressor = lzma.LZMADecompressor()
    try:
        plain = decompressor.decompress(payload)
    except lzma.LZMAError as exc:
        raise RuntimeError("Payload is not a valid xz stream") from exc
    if not decompressor.eof:
        raise RuntimeError("Payload does not contain a complete xz stream")
    validation_head = plain[:4096]
    if not validation_head:
        raise RuntimeError("Payload does not decompress into usable content")
    stream_size = len(payload) - len(decompressor.unused_data)
    if stream_size <= 0:
        raise RuntimeError("Resolved xz stream size is invalid")
    return payload[:stream_size], len(validation_head)


def _validate_xz_file(path: pathlib.Path) -> tuple[bytes, int, str, int]:
    payload = path.read_bytes()
    stream_payload, validation_size = _extract_valid_xz_stream(payload)
    return stream_payload, len(stream_payload), hashlib.sha256(stream_payload).hexdigest(), validation_size


def _try_extract_embedded_xz(path: pathlib.Path) -> tuple[bytes, int, str, int, int] | None:
    try:
        payload = path.read_bytes()
    except OSError:
        return None
    start = 0
    attempts = 0
    while attempts < 4:
        offset = payload.find(XZ_MAGIC, start)
        if offset < 0:
            return None
        attempts += 1
        try:
            stream_payload, validation_size = _extract_valid_xz_stream(payload[offset:])
            return stream_payload, len(stream_payload), hashlib.sha256(stream_payload).hexdigest(), validation_size, offset
        except RuntimeError:
            start = offset + 1
    return None


__all__ = [
    "LOCAL_SCAN_FILENAMES",
    "LOCAL_SCAN_DIR_PATTERNS",
    "LOCAL_SCAN_EXTRA_EXTENSIONS",
    "LOCAL_CONTAINER_HINTS",
    "MAX_LOCAL_SCAN_DEPTH",
    "MAX_LOCAL_CONTAINER_FILES",
    "MAX_LOCAL_CONTAINER_SIZE",
    "LOCAL_SOURCE_TIME_BUDGET_SEC",
    "XZ_MAGIC",
    "_iter_local_base_dirs",
    "_collect_local_candidates",
    "_iter_local_kugou_key_candidates",
    "_iter_local_container_candidates",
    "_extract_valid_xz_stream",
    "_validate_xz_file",
    "_try_extract_embedded_xz",
]
