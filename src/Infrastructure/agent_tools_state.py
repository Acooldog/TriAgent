from __future__ import annotations

import os
import pathlib
import threading
from typing import Annotated, Any

try:
    from pydantic import BeforeValidator
    _HAS_PYDANTIC = True
except ImportError:
    _HAS_PYDANTIC = False

from src.Infrastructure.config_repository import auto_find_kgg_db_path, auto_find_kugou_key
from src.Infrastructure.kugou_decoder import (
    DEFAULT_KGG_DB_PATH,
    DEFAULT_KEY_PATH,
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


# 延迟初始化 PATHS，避免模块加载时路径尚未准备好
_PATHS: RuntimePaths | None = None


def _get_paths() -> RuntimePaths:
    global _PATHS
    if _PATHS is None:
        _PATHS = RuntimePaths.discover()
    return _PATHS


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


# 全局权限模式存储（使用全局变量而非 threading.local，因为工具调用可能跨线程）
_permission_mode: str = "standard"


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


if _HAS_PYDANTIC:
    _CliArgs = Annotated[list[str] | None, BeforeValidator(_coerce_cli_args)]
else:
    _CliArgs = list[str] | None  # type: ignore[assignment]


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


__all__ = [
    "tool",
    "_PATHS",
    "_get_paths",
    "_ask_user_callback",
    "_callback_lock",
    "set_ask_user_callback",
    "_get_ask_user_callback",
    "_permission_mode",
    "set_permission_mode",
    "_get_permission_mode",
    "_find_kugou_key",
    "_find_kgg_db",
    "_to_path",
    "_coerce_cli_args",
    "_CliArgs",
    "_SAFE_CLI_COMMANDS",
    "_DANGEROUS_CLI_COMMANDS",
    "_ALLOWED_CLI_COMMANDS",
    "_safe_tool_name",
]
