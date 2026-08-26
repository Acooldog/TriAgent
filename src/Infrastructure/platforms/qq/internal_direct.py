from __future__ import annotations
import logging
import shutil
import time
from dataclasses import dataclass
from pathlib import Path
import frida
from src.Infrastructure.platforms.qq.scripts import build_active_script, build_redirect_script
from src.Infrastructure.platforms.qq.internal_direct_helpers import (
    ACTIVE_ARG0_HEX,
    ACTIVE_ARG1_HEX,
    CACHE_DIR,
    PICTURE_DIR,
    QUALITY_SUFFIX_RE,
    _detect_container_fast,
    _derive_title_hints,
    _find_qqmusic_pid,
    _find_source_cache_path,
    _pick_cover_path,
    _run_active_helper,
)

logger = logging.getLogger("qkkdecrypt.infrastructure.qq_internal_direct")

@dataclass(slots=True)
class QQInternalDirectResult:
    status: str
    staged_path: str | None = None
    source_cache_path: str | None = None
    original_output_path: str | None = None
    cover_path: str | None = None
    message: str = ""

class QQInternalDirectDecryptService:
    """Reuse QQMusic's live internal decrypt route by redirecting its FLAC output path."""

    DECRYPT_CACHE_FILE_RVA = 0x1845C0

    def __init__(self, *, timeout_seconds: float = 6.0):
        self.timeout_seconds = timeout_seconds

    def stage_internal_flac(self, source_file_path: str, stage_path: str, *, wait_seconds: float | None = None) -> QQInternalDirectResult:
        timeout = self.timeout_seconds if wait_seconds is None else max(wait_seconds, 0.0)
        pid = _find_qqmusic_pid()
        if pid is None:
            return QQInternalDirectResult(status="qq_not_running", message="QQMusic.exe is not running")
        sample = Path(source_file_path)
        target = Path(stage_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            try:
                target.unlink()
            except OSError:
                pass
        source_cache_path = _find_source_cache_path(sample)
        if source_cache_path is not None:
            return self._stage_active_direct(sample=sample, target=target, pid=pid, source_cache_path=source_cache_path)
        artist_hint, title_hint = _derive_title_hints(sample)
        return self._stage_live_redirect(
            sample=sample, target=target, timeout=timeout,
            artist_hint=artist_hint, title_hint=title_hint, pid=pid,
        )

    @staticmethod
    def _as_text(value: object) -> str | None:
        if value is None:
            return None
        return str(value)

    def _stage_live_redirect(
        self, *, sample: Path, target: Path, timeout: float,
        artist_hint: str, title_hint: str, pid: int,
    ) -> QQInternalDirectResult:
        session = None
        script = None
        result: dict[str, object] = {"status": "timeout"}
        script_error: dict[str, str] = {}
        try:
            session = frida.attach(pid)
            script = session.create_script(build_redirect_script(
                decrypt_rva=self.DECRYPT_CACHE_FILE_RVA, sample_name=sample.name,
                artist_hint=artist_hint, title_hint=title_hint, output_path=str(target),
            ))
            def on_message(message, _data):
                if message.get("type") == "send":
                    payload = message.get("payload", {})
                    kind = payload.get("kind")
                    if kind == "redirect_applied":
                        result.update({
                            "status": "redirect_applied",
                            "source_cache_path": payload.get("src_path"),
                            "original_output_path": payload.get("original_output"),
                            "cover_path": payload.get("cover_path"),
                        })
                    elif kind == "redirect_result":
                        result.update({
                            "status": "staged" if payload.get("retval") == 1 else "invoke_failed",
                            "staged_path": payload.get("final_output"),
                            "source_cache_path": payload.get("src_path"),
                            "cover_path": payload.get("cover_path"),
                            "retval": payload.get("retval"),
                        })
                elif message.get("type") == "error":
                    script_error["message"] = message.get("description") or message.get("stack") or "script error"
            script.on("message", on_message)
            script.load()
            deadline = time.time() + timeout
            while time.time() < deadline:
                if result.get("status") == "staged":
                    break
                if script_error:
                    break
                time.sleep(0.2)
        except Exception as exc:
            logger.exception("QQ internal direct decrypt attach failed")
            return QQInternalDirectResult(status="attach_failed", message=str(exc))
        finally:
            if script is not None:
                try:
                    script.unload()
                except Exception:
                    pass
            if session is not None:
                try:
                    session.detach()
                except Exception:
                    pass
        if script_error:
            return QQInternalDirectResult(status="hook_error", message=script_error["message"])
        status = str(result.get("status") or "timeout")
        if status == "staged":
            staged_path = str(result.get("staged_path") or target)
            if Path(staged_path).exists() and Path(staged_path).stat().st_size > 1024:
                logger.info("QQ internal direct decrypt staged: %s", staged_path)
                return QQInternalDirectResult(
                    status="staged", staged_path=staged_path,
                    source_cache_path=self._as_text(result.get("source_cache_path")),
                    original_output_path=self._as_text(result.get("original_output_path")),
                    cover_path=self._as_text(result.get("cover_path")),
                    message="reused QQMusic live decrypt route",
                )
            return QQInternalDirectResult(
                status="output_missing", staged_path=staged_path,
                source_cache_path=self._as_text(result.get("source_cache_path")),
                message="QQ internal decrypt reported success but output file was not found",
            )
        if status == "invoke_failed":
            return QQInternalDirectResult(
                status="invoke_failed",
                source_cache_path=self._as_text(result.get("source_cache_path")),
                message=f"QQ internal decrypt returned {result.get('retval')}",
            )
        if status == "redirect_applied":
            return QQInternalDirectResult(
                status="output_missing",
                source_cache_path=self._as_text(result.get("source_cache_path")),
                original_output_path=self._as_text(result.get("original_output_path")),
                cover_path=self._as_text(result.get("cover_path")),
                message="QQ internal decrypt started but no completed output was observed",
            )
        return QQInternalDirectResult(status="timeout", message="QQ internal decrypt did not trigger within timeout")

    def _stage_active_direct(self, *, sample: Path, target: Path, pid: int, source_cache_path: Path) -> QQInternalDirectResult:
        target.parent.mkdir(parents=True, exist_ok=True)
        temp_ascii_dir = target.parent / "_qq_internal_direct"
        temp_ascii_dir.mkdir(parents=True, exist_ok=True)
        source_ext = source_cache_path.suffix or ".mflac"
        active_source = temp_ascii_dir / f"source{source_ext}"
        active_output = temp_ascii_dir / "output.flac"
        active_cover: Path | None = None
        if active_output.exists():
            try:
                active_output.unlink()
            except OSError:
                pass
        try:
            if source_cache_path.resolve() != active_source.resolve():
                shutil.copyfile(source_cache_path, active_source)
        except OSError as exc:
            return QQInternalDirectResult(status="output_missing", source_cache_path=str(source_cache_path), message=f"failed to stage QQ cache source: {exc}")
        cover_path = _pick_cover_path()
        try:
            active_cover = temp_ascii_dir / cover_path.name
            shutil.copyfile(cover_path, active_cover)
        except OSError:
            active_cover = None
        if active_cover is None or not active_cover.exists():
            fallback_cover = temp_ascii_dir / "cover.png"
            try:
                shutil.copyfile(cover_path, fallback_cover)
                active_cover = fallback_cover
            except OSError:
                active_cover = cover_path
        helper = _run_active_helper(source_cache_path=active_source, output_path=active_output, cover_path=Path(str(active_cover)))
        if helper["status"] == "attach_failed":
            return QQInternalDirectResult(status="attach_failed", source_cache_path=str(source_cache_path), cover_path=str(active_cover), message=str(helper.get("message") or "helper attach failed"))
        if helper["status"] == "hook_error":
            return QQInternalDirectResult(status="hook_error", source_cache_path=str(source_cache_path), cover_path=str(active_cover), message=str(helper.get("message") or "helper hook error"))
        if helper["status"] == "invoke_failed":
            return QQInternalDirectResult(status="invoke_failed", source_cache_path=str(source_cache_path), cover_path=str(active_cover), message=str(helper.get("message") or "QQ direct decrypt returned 0"))
        if helper["status"] == "staged" and active_output.exists() and active_output.stat().st_size > 1024:
            detected_container = _detect_container_fast(active_output)
            if detected_container == "bin":
                return QQInternalDirectResult(
                    status="output_missing", source_cache_path=str(source_cache_path),
                    cover_path=str(active_cover),
                    message="QQ direct decrypt produced an unrecognized container",
                )
            try:
                shutil.copyfile(active_output, target)
            except OSError as exc:
                return QQInternalDirectResult(
                    status="output_missing", source_cache_path=str(source_cache_path),
                    cover_path=str(active_cover),
                    message=f"QQ direct decrypt produced a staged file but final copy failed: {exc}",
                )
            return QQInternalDirectResult(
                status="staged", staged_path=str(target),
                source_cache_path=str(source_cache_path),
                original_output_path=str(active_output),
                cover_path=str(active_cover),
                message="triggered QQ internal decrypt_cache_file directly",
            )
        return QQInternalDirectResult(status="output_missing", source_cache_path=str(source_cache_path), cover_path=str(active_cover), message="QQ direct decrypt call did not produce output")

    def _stage_active_direct_from_source_alias(self, *, sample: Path, target: Path, pid: int) -> QQInternalDirectResult:
        temp_ascii_dir = target.parent / "_qq_internal_direct"
        temp_ascii_dir.mkdir(parents=True, exist_ok=True)
        alias_source = temp_ascii_dir / "source.mflac"
        try:
            shutil.copyfile(sample, alias_source)
        except OSError as exc:
            return QQInternalDirectResult(status="output_missing", source_cache_path=str(sample), message=f"failed to stage source alias: {exc}")
        result = self._stage_active_direct(sample=sample, target=target, pid=pid, source_cache_path=alias_source)
        if result.status == "staged":
            result.source_cache_path = str(sample)
            result.message = "triggered QQ internal decrypt_cache_file via staged source alias"
        return result

__all__ = [
    "QQInternalDirectResult",
    "QQInternalDirectDecryptService",
]
