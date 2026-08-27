from __future__ import annotations

import pathlib
import sys
from typing import Any

from src.Domain.ports import RuntimePort
from src.Application.decrypt.decrypt_service import run_batch
from src.Application.models import BatchRunConfig
from src.Application.services.config_service import (
    config_service, default_kuwo_signature_path,
)
from src.Application.services.platform_service import create_platform_adapter
from src.Application.services.kugou_service import kugou_service

from src.Presentation.cli.cli_prompts import (
    PLATFORM_LABELS, build_transcode_confirmation_resolver, choose_platform,
    collision_prompt, is_running_as_admin, pause_exit, prompt_bool, prompt_choice,
    prompt_with_default,
)


def _ensure_running_for_interactive(platform_id: str, adapter, settings: dict) -> tuple[bool, str | None]:
    ok, reason = adapter.validate_runtime(settings)
    if ok:
        return True, None
    print(f"未检测到{PLATFORM_LABELS[platform_id]}，请先开启对应软件。")
    value = input("开启完成后输入 y 继续验证，否则按任意键退出: ").strip().lower()
    if value != "y":
        return False, reason or "user_cancelled"
    ok, reason = adapter.validate_runtime(settings)
    if ok:
        return True, None
    return False, reason or "target_process_not_detected"


def _validate_kugou_runtime(paths: RuntimePort, config: dict, input_path: pathlib.Path,
                             recursive: bool, interactive: bool) -> tuple[bool, str | None, dict]:
    adapter = create_platform_adapter("kugou")
    settings = dict(config["kugou"])
    key_file = pathlib.Path(str(settings.get("key_file", "") or "").strip()) if str(settings.get("key_file", "")).strip() else None
    auto_key = config_service.auto_find_kugou_key(paths)
    if (key_file is None or not key_file.exists()) and auto_key is not None:
        settings["key_file"] = str(auto_key)
    ok, reason = adapter.validate_runtime(settings)
    if not ok:
        return False, reason, settings
    candidate_files = adapter.collect_files(input_path, recursive)
    has_kgg = any(path.suffix.lower() == ".kgg" for path in candidate_files)
    db_path = pathlib.Path(str(settings.get("kgg_db_path", "") or "").strip()) if str(settings.get("kgg_db_path", "")).strip() else pathlib.Path()
    if has_kgg and (not db_path.exists()):
        found = config_service.auto_find_kgg_db_path()
        if found is not None:
            settings["kgg_db_path"] = str(found)
        else:
            return False, "未找到可用的 KGMusicV3.db，无法解密 kgg。", settings
    return True, None, settings


def _run_platform(platform_id: str, config: dict, *,
                  input_override: str | None = None, output_override: str | None = None,
                  recursive_override: bool | None = None, interactive: bool = False) -> int:
    paths = config_service.discover_runtime_paths()
    adapter = create_platform_adapter(platform_id)
    shared = dict(config["shared"])
    settings = dict(config[platform_id])
    settings["transcode_enabled"] = bool(shared.get("transcode_enabled", True))
    settings["embed_cover_art"] = bool(shared.get("embed_cover_art", True))
    settings["supplement_album_metadata"] = bool(shared.get("supplement_album_metadata", False))
    input_path = pathlib.Path(input_override or settings.get("input_dir") or "")
    output_dir = pathlib.Path(output_override or shared.get("output_dir") or paths.output_dir)
    recursive = bool(config.get("shared", {}).get("recursive", True)) if recursive_override is None else recursive_override
    if platform_id == "kugou":
        ok, reason, settings = _validate_kugou_runtime(paths, config, input_path, recursive, interactive)
        if not ok:
            if not interactive and reason:
                print(reason, file=sys.stderr)
            return pause_exit(2, reason) if interactive else 2
    elif adapter.requires_running_process():
        if interactive:
            ok, reason = _ensure_running_for_interactive(platform_id, adapter, settings)
            if not ok:
                return pause_exit(2, reason)
        else:
            ok, reason = adapter.validate_runtime(settings)
            if not ok:
                if reason:
                    print(reason, file=sys.stderr)
                return 2
    config[platform_id].update(settings)
    batch_config = BatchRunConfig(
        platform_id=platform_id, input_path=input_path, output_dir=output_dir,
        recursive=recursive, collision_policy=str(shared.get("cli_collision_policy", "suffix") or "suffix").lower(),
        settings=settings, interactive=interactive,
        collision_resolver=collision_prompt if interactive else None,
        transcode_confirmation_resolver=build_transcode_confirmation_resolver(paths=paths, config=config, platform_id=platform_id),
    )
    config["shared"]["output_dir"] = str(output_dir)
    config["shared"]["recursive"] = recursive
    config[platform_id]["input_dir"] = str(input_path)
    root, _ = config_service.load(paths)
    config_service.save(paths, root, config)
    return run_batch(batch_config, adapter)


def run_interactive() -> int:
    paths = config_service.discover_runtime_paths()
    config = config_service.ensure_default(paths)
    print(config_service.build_banner(paths))
    use_config = prompt_bool("是否直接使用配置文件的配置", True)
    platform_id = choose_platform()
    if platform_id not in PLATFORM_LABELS:
        return pause_exit(2, "平台选择无效。")
    if use_config:
        return pause_exit(_run_platform(platform_id, config, interactive=True))

    shared = dict(config["shared"])
    settings = dict(config[platform_id])
    input_dir = pathlib.Path(prompt_with_default("输入文件或目录", str(settings.get("input_dir", ""))))
    output_dir = pathlib.Path(prompt_with_default("共享输出目录", str(shared.get("output_dir", paths.output_dir))))
    recursive = prompt_bool("递归扫描子目录", bool(shared.get("recursive", True)))
    shared["transcode_enabled"] = prompt_bool("是否转码（关闭后直接输出解密后的原始音频格式）", bool(shared.get("transcode_enabled", True)))
    shared["embed_cover_art"] = prompt_bool("是否自动补封面（所有平台共用，可能会导致转换明显变慢）", bool(shared.get("embed_cover_art", True)))
    shared["supplement_album_metadata"] = prompt_bool("是否补充专辑信息（仅对 m4a/wav 生效，优先本地后网络）", bool(shared.get("supplement_album_metadata", False)))

    if not bool(shared.get("transcode_enabled", True)):
        pass
    elif platform_id == "qq":
        rules = dict(settings.get("format_rules", {}))
        rules["mflac"] = prompt_choice("mflac 输出格式 flac/m4a/mp3/wav", str(rules.get("mflac", "flac")), config_service.supported_target_formats())
        rules["mgg"] = prompt_choice("mgg 输出格式 flac/m4a/mp3/wav", str(rules.get("mgg", "m4a")), config_service.supported_target_formats())
        rules["mmp4"] = prompt_choice("mmp4 输出格式 flac/m4a/mp3/wav", str(rules.get("mmp4", "m4a")), config_service.supported_target_formats())
        settings["format_rules"] = rules
    elif platform_id == "kuwo":
        settings["format_kwm"] = prompt_choice("kwm 输出格式 auto/flac/m4a/mp3/wav", str(settings.get("format_kwm", "auto")), config_service.supported_target_formats())
        settings["signature_file"] = str(config_service.default_kuwo_signature_path(paths))
    elif platform_id == "kugou":
        settings["target_format_kgma"] = prompt_choice("kgma/kgm/vpr 输出格式 auto/flac/m4a/mp3/wav", str(settings.get("target_format_kgma", "auto")), config_service.supported_target_formats())
        settings["target_format_kgg"] = prompt_choice("kgg 输出格式 auto/flac/m4a/mp3/wav", str(settings.get("target_format_kgg", "auto")), config_service.supported_target_formats())
        auto_key = config_service.auto_find_kugou_key(paths)
        if auto_key is not None:
            settings["key_file"] = str(auto_key)
        if prompt_bool("是否立即抓取新的 kugou_key.xz", False):
            try:
                configured_path = pathlib.Path(str(settings.get("key_file", "") or "").expanduser()) if str(settings.get("key_file", "") or "").strip() else None
                target_path = configured_path if configured_path and configured_path.name.lower() != "kugou_key.xz" else kugou_service.default_refreshed_key_path(paths)
                result = kugou_service.refresh_key(paths, destination=target_path)
                settings["key_file"] = str(result.output_path)
                print(f"已更新 kugou_key.xz：{result.output_path}")
            except Exception as exc:
                print(f"抓取 kugou_key.xz 失败：{exc}")
    else:
        settings["target_format_ncm"] = prompt_choice("ncm 输出格式 auto/flac/m4a/mp3/wav", str(settings.get("target_format_ncm", "auto")), config_service.supported_target_formats())

    config[platform_id].update(settings)
    config["shared"].update(shared)
    config[platform_id]["input_dir"] = str(input_dir)
    config["shared"]["output_dir"] = str(output_dir)
    config["shared"]["recursive"] = recursive
    root, _ = config_service.load(paths)
    config_service.save(paths, root, config)
    if not prompt_bool("立即开始解密", True):
        return pause_exit(0, "配置已保存。")
    return pause_exit(_run_platform(platform_id, config, interactive=True))


def _require_admin(*, interactive: bool) -> int | None:
    if is_running_as_admin():
        return None
    message = "请使用管理员身份启动 A_QKKd。当前不是管理员启动，已禁止继续使用。"
    if interactive:
        return pause_exit(2, message)
    print(message, file=sys.stderr)
    return 2


def _shared_recursive(config: dict) -> bool:
    return bool(config.get("shared", {}).get("recursive", True))


__all__ = [
    "_run_platform", "run_interactive", "_require_admin", "_shared_recursive",
    "_ensure_running_for_interactive", "_validate_kugou_runtime",
]
