from __future__ import annotations

import hashlib
import lzma
import pathlib
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass

from src.Infrastructure.kugou_key_utils import (
    LOCAL_SOURCE_TIME_BUDGET_SEC,
    _extract_valid_xz_stream,
    _iter_local_container_candidates,
    _iter_local_kugou_key_candidates,
    _try_extract_embedded_xz,
    _validate_xz_file,
)
from src.Infrastructure.runtime_paths import RuntimePaths


USER_AGENT = "QKKDecrypt/refresh-kugou-key"
DEFAULT_TIMEOUT_SEC = 10
DEFAULT_BRANCH_CANDIDATES = ("main", "main-ui")
REFRESHED_KEY_FILENAME = "kugou_key_refreshed.xz"
LEGACY_KEY_FILENAME = "kugou_key.xz"


@dataclass(frozen=True, slots=True)
class KugouKeyRefreshResult:
    output_path: pathlib.Path
    source_url: str
    file_size: int
    sha256: str
    validation_size: int


def _candidate_urls(branch_candidates: tuple[str, ...]) -> list[str]:
    urls: list[str] = []
    seen: set[str] = set()
    for branch in branch_candidates:
        for template in (
            "https://gitee.com/daoges_x/QQKWKG-TriMusicDecrypt/raw/{branch}/assets/kugou_key.xz",
            "https://raw.githubusercontent.com/Acooldog/QQKWKG-TriMusicDecrypt/{branch}/assets/kugou_key.xz",
        ):
            url = template.format(branch=branch)
            if url not in seen:
                seen.add(url)
                urls.append(url)
    return urls


def default_refreshed_kugou_key_path(paths: RuntimePaths) -> pathlib.Path:
    return (paths.root_dir / "assets" / REFRESHED_KEY_FILENAME).resolve()


def refresh_kugou_key(
    paths: RuntimePaths,
    *,
    destination: pathlib.Path | None = None,
    branch_candidates: tuple[str, ...] = DEFAULT_BRANCH_CANDIDATES,
    timeout_sec: int = DEFAULT_TIMEOUT_SEC,
) -> KugouKeyRefreshResult:
    paths.ensure_runtime_dirs()
    output_path = (destination or default_refreshed_kugou_key_path(paths)).expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temp_dir = pathlib.Path(tempfile.mkdtemp(prefix="kugou_key_refresh_", dir=str(paths.log_dir)))
    errors: list[str] = []

    try:
        local_started = time.perf_counter()
        for local_path in _iter_local_kugou_key_candidates(output_path):
            try:
                stream_payload, file_size, sha256, validation_size = _validate_xz_file(local_path)
                output_path.write_bytes(stream_payload)
                return KugouKeyRefreshResult(
                    output_path=output_path, source_url=str(local_path),
                    file_size=file_size, sha256=sha256, validation_size=validation_size,
                )
            except (OSError, RuntimeError, lzma.LZMAError, EOFError) as exc:
                errors.append(f"{local_path} -> {exc}")

        for container_path in _iter_local_container_candidates():
            if time.perf_counter() - local_started >= LOCAL_SOURCE_TIME_BUDGET_SEC:
                errors.append("Local embedded scan time budget exceeded")
                break
            try:
                extracted = _try_extract_embedded_xz(container_path)
            except OSError as exc:
                errors.append(f"{container_path} -> {exc}")
                continue
            if extracted is None:
                continue
            stream_payload, file_size, sha256, validation_size, offset = extracted
            output_path.write_bytes(stream_payload)
            return KugouKeyRefreshResult(
                output_path=output_path, source_url=f"embedded:{container_path}#offset={offset}",
                file_size=file_size, sha256=sha256, validation_size=validation_size,
            )

        for url in _candidate_urls(branch_candidates):
            temp_path = temp_dir / f"{int(time.time() * 1000)}.xz"
            try:
                request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(request, timeout=timeout_sec) as response:
                    payload = response.read()
                if not payload:
                    raise RuntimeError("Downloaded payload is empty")
                temp_path.write_bytes(payload)
                stream_payload, validation_size = _extract_valid_xz_stream(payload)
                output_path.write_bytes(stream_payload)
                return KugouKeyRefreshResult(
                    output_path=output_path, source_url=url,
                    file_size=len(stream_payload),
                    sha256=hashlib.sha256(stream_payload).hexdigest(),
                    validation_size=validation_size,
                )
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError, RuntimeError, ValueError, lzma.LZMAError, EOFError) as exc:
                errors.append(f"{url} -> {exc}")
                try:
                    temp_path.unlink(missing_ok=True)
                except Exception:
                    pass
        joined = "; ".join(errors) if errors else "No usable local or remote Kugou key source matched"
        raise RuntimeError(f"Failed to refresh kugou_key.xz: {joined}")
    finally:
        try:
            temp_dir.rmdir()
        except OSError:
            pass


# Re-export constants consumed externally
from src.Infrastructure.kugou_key_utils import (  # noqa: E402,F401
    LOCAL_CONTAINER_HINTS,
    LOCAL_SCAN_DIR_PATTERNS,
    LOCAL_SCAN_EXTRA_EXTENSIONS,
    LOCAL_SCAN_FILENAMES,
    MAX_LOCAL_CONTAINER_FILES,
    MAX_LOCAL_CONTAINER_SIZE,
    MAX_LOCAL_SCAN_DEPTH,
    XZ_MAGIC,
    _collect_local_candidates,
    _iter_local_base_dirs,
)

__all__ = [
    "USER_AGENT",
    "DEFAULT_TIMEOUT_SEC",
    "DEFAULT_BRANCH_CANDIDATES",
    "REFRESHED_KEY_FILENAME",
    "LEGACY_KEY_FILENAME",
    "LOCAL_SCAN_FILENAMES",
    "LOCAL_SCAN_DIR_PATTERNS",
    "LOCAL_SCAN_EXTRA_EXTENSIONS",
    "LOCAL_CONTAINER_HINTS",
    "MAX_LOCAL_SCAN_DEPTH",
    "MAX_LOCAL_CONTAINER_FILES",
    "MAX_LOCAL_CONTAINER_SIZE",
    "LOCAL_SOURCE_TIME_BUDGET_SEC",
    "XZ_MAGIC",
    "KugouKeyRefreshResult",
    "_candidate_urls",
    "default_refreshed_kugou_key_path",
    "refresh_kugou_key",
    "_iter_local_base_dirs",
    "_collect_local_candidates",
    "_iter_local_kugou_key_candidates",
    "_iter_local_container_candidates",
    "_extract_valid_xz_stream",
    "_validate_xz_file",
    "_try_extract_embedded_xz",
]
