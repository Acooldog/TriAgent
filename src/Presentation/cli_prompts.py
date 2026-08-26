from __future__ import annotations

import ctypes
import pathlib
import sys
from typing import Any, Callable

from src.Infrastructure.config_repository import (
    load_config,
    save_config,
    TRANSCODE_BITRATE_OPTIONS,
    TRANSCODE_SAMPLE_RATE_OPTIONS,
)
from src.Infrastructure.runtime_paths import RuntimePaths


PLATFORM_LABELS = {"qq": "QQ音乐", "kuwo": "酷我音乐", "kugou": "酷狗音乐", "netease": "网易云音乐"}


def is_running_as_admin() -> bool:
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def pause_exit(code: int = 0, message: str | None = None) -> int:
    if message:
        print(message)
    try:
        input("按任意键退出...")
    except EOFError:
        pass
    return code


def prompt_with_default(prompt: str, default: str) -> str:
    value = input(f"{prompt} [{default}]: ").strip()
    return value or default


def prompt_bool(prompt: str, default: bool) -> bool:
    label = "Y/n" if default else "y/N"
    value = input(f"{prompt} [{label}]: ").strip().lower()
    if not value:
        return default
    return value in {"y", "yes", "1", "true"}


def prompt_choice(prompt: str, default: str, choices: list[str]) -> str:
    allowed = {choice.lower() for choice in choices}
    value = input(f"{prompt} [{default}]: ").strip().lower()
    if not value:
        return default
    if value not in allowed:
        raise ValueError(f"unsupported option: {value}")
    return value


def prompt_optional_choice_int(prompt: str, default: int | None, choices: tuple[int, ...]) -> int | None:
    default_label = str(default) if default is not None else "关闭"
    raw = input(f"{prompt} [{default_label}，输入 off 关闭]: ").strip().lower()
    if not raw:
        return default
    if raw in {"off", "none", "disable", "close", "关闭"}:
        return None
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"unsupported numeric option: {raw}") from exc
    if value not in choices:
        allowed = ", ".join(str(item) for item in choices)
        raise ValueError(f"unsupported numeric option: {value}; allowed: {allowed}")
    return value


def configure_platform_transcode_profile(settings: dict[str, Any]) -> None:
    settings["transcode_sample_rate_hz"] = prompt_optional_choice_int(
        "指定采样率（仅在转码时生效）",
        settings.get("transcode_sample_rate_hz"),
        TRANSCODE_SAMPLE_RATE_OPTIONS,
    )
    settings["transcode_bitrate_kbps"] = prompt_optional_choice_int(
        "指定比特率（仅在转码到有损格式时生效）",
        settings.get("transcode_bitrate_kbps"),
        TRANSCODE_BITRATE_OPTIONS,
    )


def choose_platform() -> str:
    print("请选择平台:")
    print("1. QQ音乐")
    print("2. 酷我音乐")
    print("3. 酷狗音乐")
    print("4. 网易云音乐")
    mapping = {
        "1": "qq",
        "2": "kuwo",
        "3": "kugou",
        "4": "netease",
        "qq": "qq",
        "kuwo": "kuwo",
        "kugou": "kugou",
        "netease": "netease",
        "wangyiyun": "netease",
    }
    value = input("平台 [1]: ").strip().lower() or "1"
    return mapping.get(value, "")


def collision_prompt(base_name: str, extension: str, existing_platform: str | None) -> str:
    print(f"检测到共享输出冲突: {base_name}.{extension}")
    print(f"现有来源平台: {existing_platform or '未知'}")
    print("1. 加平台后缀")
    print("2. 分平台子目录")
    print("3. 覆盖")
    value = input("选择 [1]: ").strip() or "1"
    return {"1": "suffix", "2": "subdir", "3": "overwrite"}.get(value, "suffix")


def build_transcode_confirmation_resolver(
    *,
    paths: RuntimePaths,
    config: dict[str, Any],
    platform_id: str,
) -> Callable[[dict[str, Any]], tuple[bool, bool]] | None:
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        return None

    def _resolver(payload: dict[str, Any]) -> tuple[bool, bool]:
        pending_count = int(payload.get("pending_count", 0) or 0)
        ready_count = int(payload.get("ready_count", 0) or 0)
        title = PLATFORM_LABELS.get(platform_id, platform_id)
        transcode_enabled_setting = bool(payload.get("transcode_enabled_setting", True))
        if pending_count <= 0:
            if transcode_enabled_setting:
                print(f"{title} 已完成解密：共 {ready_count} 个文件，当前批次无需转码，将直接输出解码结果。")
            else:
                print(f"{title} 已完成解密：共 {ready_count} 个文件，当前处于仅解码模式，本批不会转码。")
            try:
                input("按回车继续...")
            except EOFError:
                pass
            return False, False
        print(f"{title} 已完成解密：共 {ready_count} 个文件，其中 {pending_count} 个需要按当前设置转码。")
        should_transcode = prompt_bool("是否现在统一转码", True)
        remember_choice = False
        if should_transcode:
            remember_choice = prompt_bool(
                "下次该平台解密完成后是否直接转码且不再提醒",
                bool(config.get(platform_id, {}).get("auto_transcode_after_decode", False)),
            )
            if remember_choice != bool(config.get(platform_id, {}).get("auto_transcode_after_decode", False)):
                config[platform_id]["auto_transcode_after_decode"] = remember_choice
                root, _ = load_config(paths)
                save_config(paths, root, config)
        return should_transcode, remember_choice

    return _resolver


__all__ = [
    "PLATFORM_LABELS",
    "is_running_as_admin",
    "pause_exit",
    "prompt_with_default",
    "prompt_bool",
    "prompt_choice",
    "prompt_optional_choice_int",
    "configure_platform_transcode_profile",
    "choose_platform",
    "collision_prompt",
    "build_transcode_confirmation_resolver",
]
