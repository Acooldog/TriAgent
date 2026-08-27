"""Agent config preflight — 模型配置清理和 LLM 连接预检。

从 agent_executor.py 拆出，负责：
- 清理 model_config 中的特殊字符（反引号、尾部逗号等）
- 轻量级 API 端点可达性检查
"""
from __future__ import annotations

from typing import Any, Callable


def clean_model_config(model_config: dict[str, Any], log_fn: Callable[[str, str], None]) -> None:
    """清理 model_config 中 base_url/api_key/model/provider 的特殊字符。"""
    from src.Infrastructure.adapters.agent.config.agent_model import _clean_field
    if not isinstance(model_config, dict):
        return
    for key in ("base_url", "api_key", "model", "provider"):
        val = model_config.get(key)
        if isinstance(val, str):
            original = val
            cleaned = _clean_field(val)
            if cleaned != original:
                log_fn(f"清理 model_config.{key}: {original!r} → {cleaned!r}", "debug")
                model_config[key] = cleaned


class PreflightResult:
    """预检结果。ok=True 表示通过，ok=False 表示需要提前退出。"""
    def __init__(self, ok: bool, *, error: str | None = None, status: str | None = None, extra: dict | None = None):
        self.ok = ok
        self.error = error
        self.status = status
        self.extra = extra or {}

    @staticmethod
    def ok_result() -> "PreflightResult":
        return PreflightResult(True)

    @staticmethod
    def fail(status: str, error: str, **extra) -> "PreflightResult":
        return PreflightResult(False, error=error, status=status, extra=dict(extra))


def check_llm_connectivity(model_config: dict[str, Any], log_fn: Callable[[str, str], None]) -> PreflightResult:
    """轻量预检：检查 base_url 可达 + api_key 非空。

    Returns:
        PreflightResult: ok=True 表示通过；ok=False 表示应提前退出。
    """
    bu = str(model_config.get("base_url", ""))
    ak = str(model_config.get("api_key", ""))
    bl = bu.lower()
    is_local = "localhost" in bl or "127.0.0.1" in bl or "0.0.0.0" in bl

    if not ak and not is_local:
        log_fn("LLM 配置错误：api_key 为空", "error")
        return PreflightResult.fail("error", "missing_api_key")

    try:
        import urllib.request as ur
        import urllib.error as ue
        probe = bu.rstrip("/").removesuffix("/chat/completions") + "/chat/completions"
        req = ur.Request(probe, method="HEAD", headers={"User-Agent": "TriMusicAgent/1.0"})
        resp = ur.urlopen(req, timeout=8)
        log_fn(f"模型服务可达 (HTTP {resp.status}, 端点 {probe})", "info")
        return PreflightResult.ok_result()
    except Exception as url_exc:
        code = getattr(url_exc, "code", None)
        if code in (405, 401, 403):
            log_fn(f"模型服务可达 (HTTP {code}, 端点存在但拒绝 HEAD)", "info")
            return PreflightResult.ok_result()
        elif code == 404:
            log_fn(f"模型端点不存在: {probe} → HTTP 404", "error")
            return PreflightResult.fail("error", f"endpoint_not_found: {probe}")
        else:
            log_fn(f"模型服务不可达: {url_exc}", "error")
            return PreflightResult.fail("error", f"llm_unreachable: {url_exc}")


__all__ = [
    "clean_model_config",
    "check_llm_connectivity",
    "PreflightResult",
]
