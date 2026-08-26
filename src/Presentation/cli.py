from __future__ import annotations

import argparse
import pathlib
import sys
from typing import Any

from src.Application.transcode_batch_service import ALL_SOURCE_FORMAT, run_transcode_batch
from src.Infrastructure.config_repository import (
    PROJECT_ADDRESS, PROJECT_NAME_EN, PROJECT_NAME_ZH, PROJECT_QQ,
    default_kuwo_signature_path, format_help_epilog, load_config,
    save_config, save_default_config_if_missing, supported_transcode_formats,
    validate_target_format,
)
from src.Infrastructure.kugou_key_refresh import default_refreshed_kugou_key_path, refresh_kugou_key
from src.Infrastructure.runtime_paths import RuntimePaths

from src.Presentation.cli_prompts import (
    PLATFORM_LABELS, build_transcode_confirmation_resolver, choose_platform,
    collision_prompt, is_running_as_admin, pause_exit, prompt_bool, prompt_choice,
    prompt_with_default,
)
from src.Presentation.cli_run import (
    _ensure_running_for_interactive, _require_admin, _run_platform,
    _shared_recursive, _validate_kugou_runtime, run_interactive,
)


def parse_transcode_rule_spec(spec: str) -> dict[str, Any]:
    parts = [segment.strip() for segment in str(spec or "").split(":")]
    if len(parts) < 2 or len(parts) > 4:
        raise ValueError("rule format must be <source>:<target>[:sample_rate_hz[:bitrate_kbps]]")
    source_format = parts[0] or ALL_SOURCE_FORMAT
    if source_format.lower() == "all":
        source_format = ALL_SOURCE_FORMAT
    target_format = parts[1] or "m4a"
    sample_rate_hz = int(parts[2]) if len(parts) >= 3 and parts[2] else None
    bitrate_kbps = int(parts[3]) if len(parts) >= 4 and parts[3] else None
    return {
        "source_format": source_format, "target_format": target_format,
        "sample_rate_hz": sample_rate_hz, "bitrate_kbps": bitrate_kbps,
    }


def _transcode_rule_label(rule: dict[str, Any]) -> str:
    parts = [f"{rule.get('source_format', ALL_SOURCE_FORMAT)} -> {rule.get('target_format', 'm4a')}"]
    if rule.get("sample_rate_hz"):
        parts.append(f"{rule['sample_rate_hz']} Hz")
    if rule.get("bitrate_kbps"):
        parts.append(f"{rule['bitrate_kbps']} kbps")
    return " | ".join(parts)


def build_transcode_batch_event_sink() -> Any:
    def _sink(event_name: str, payload: dict[str, Any]) -> None:
        if event_name == "plan_ready":
            print(f"已生成批量转码计划：任务 {payload.get('total_jobs', 0)} 个，并发 {payload.get('worker_count', 0)} 路")
        elif event_name == "warning":
            print(f"警告：{payload.get('message', '')}")
        elif event_name == "job_started":
            extras = [f"{payload['sample_rate_hz']} Hz"] if payload.get("sample_rate_hz") else []
            extras.append(f"{payload['bitrate_kbps']} kbps") if payload.get("bitrate_kbps") else None
            extra_text = f"（{' / '.join(extras)}）" if extras else ""
            print(f"开始转码：{payload.get('input_path', '')} -> {payload.get('output_path', '')}{extra_text}")
        elif event_name == "job_succeeded":
            print(f"转码成功：{payload.get('output_path', '')}（{payload.get('elapsed_sec', 0)}s）")
        elif event_name == "job_failed":
            print(f"转码失败：{payload.get('input_path', '')}，原因：{payload.get('reason', '')}")
        elif event_name == "batch_finished":
            print(f"批量转码完成：成功 {payload.get('success_count', 0)}，失败 {payload.get('failed_count', 0)}，总耗时 {payload.get('elapsed_sec', 0)}s")
    return _sink


def _run_transcode_batch_cli(paths: RuntimePaths, config: dict[str, Any], args: argparse.Namespace) -> int:
    transcode_config = dict(config.get("transcode_batch", {}))
    input_values = list(args.input or transcode_config.get("input_paths", []))
    if not input_values:
        print("请通过 --input 指定至少一个输入目录，或者先在配置文件里保存 transcode_batch.input_paths。", file=sys.stderr)
        return 2
    output_dir = pathlib.Path(args.output or transcode_config.get("output_dir") or (paths.output_dir / "transcode"))
    recursive = not bool(args.no_recursive)
    max_workers = max(1, min(int(args.max_workers or transcode_config.get("max_workers", 2) or 2), 4))
    rules = [parse_transcode_rule_spec(item) for item in (args.rule or [])] or list(transcode_config.get("rules", []))
    if not rules:
        rules = [{"source_format": ALL_SOURCE_FORMAT, "target_format": "m4a", "sample_rate_hz": None, "bitrate_kbps": None}]
    config.setdefault("transcode_batch", {})["input_paths"] = [str(item) for item in input_values]
    config["transcode_batch"]["output_dir"] = str(output_dir)
    config["transcode_batch"]["recursive"] = recursive
    config["transcode_batch"]["max_workers"] = max_workers
    config["transcode_batch"]["rules"] = rules
    root, _ = load_config(paths)
    save_config(paths, root, config)
    print("批量转码配置：")
    for index, rule in enumerate(rules, start=1):
        print(f"  规则 {index}: {_transcode_rule_label(rule)}")
    result = run_transcode_batch(
        input_paths=[pathlib.Path(item) for item in input_values],
        output_dir=output_dir, rules=rules, recursive=recursive,
        max_workers=max_workers, event_sink=build_transcode_batch_event_sink(),
    )
    return 0 if result.failed_count == 0 else 1


def _run_kugou_refresh_key_cli(paths: RuntimePaths, config: dict[str, Any], args: argparse.Namespace) -> int:
    configured = str(config.get("kugou", {}).get("key_file", "") or "").strip()
    configured_path = pathlib.Path(configured).expanduser() if configured else None
    if args.output:
        output_path = pathlib.Path(args.output)
    elif configured_path and configured_path.name.lower() != "kugou_key.xz":
        output_path = configured_path
    else:
        output_path = default_refreshed_kugou_key_path(paths)
    try:
        result = refresh_kugou_key(paths, destination=output_path)
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1
    config.setdefault("kugou", {})["key_file"] = str(result.output_path)
    root, _ = load_config(paths)
    save_config(paths, root, config)
    print("已抓取新的 kugou_key.xz")
    print(f"输出路径：{result.output_path}")
    print(f"来源：{result.source_url}")
    print(f"大小：{result.file_size} bytes")
    print(f"SHA256：{result.sha256}")
    return 0


def build_parser(paths: RuntimePaths) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=f"{PROJECT_NAME_EN} / {PROJECT_NAME_ZH}", epilog=format_help_epilog(paths))
    sub = parser.add_subparsers(dest="platform")
    for platform_id in ("qq", "kuwo", "kugou", "netease"):
        platform_parser = sub.add_parser(platform_id, help=f"{PLATFORM_LABELS[platform_id]} 解密")
        platform_sub = platform_parser.add_subparsers(dest="command")
        dec = platform_sub.add_parser("decrypt", help="执行解密")
        dec.add_argument("--input", help="输入文件或目录")
        dec.add_argument("--output", help="共享输出目录")
        dec.add_argument("--no-recursive", action="store_true", help="禁用递归扫描")
        if platform_id == "qq":
            dec.add_argument("--format-mflac", choices=[item for item in supported_transcode_formats() if item != "auto"], help="mflac 输出格式")
            dec.add_argument("--format-mgg", choices=[item for item in supported_transcode_formats() if item != "auto"], help="mgg 输出格式")
            dec.add_argument("--format-mmp4", choices=[item for item in supported_transcode_formats() if item != "auto"], help="mmp4 输出格式")
        elif platform_id == "kuwo":
            dec.add_argument("--format-kwm", choices=supported_transcode_formats(), help="kwm 输出格式")
            dec.add_argument("--exe-path", help="酷我 exe 路径")
            dec.add_argument("--signature-file", help="酷我签名文件路径")
        elif platform_id == "kugou":
            dec.add_argument("--kgg-db", help="KGMusicV3.db 路径")
            dec.add_argument("--key-file", help="kugou_key.xz 路径")
            dec.add_argument("--format-kgma", choices=supported_transcode_formats(), help="kgma/kgm/vpr 输出格式")
            dec.add_argument("--format-kgg", choices=supported_transcode_formats(), help="kgg 输出格式")
            refresh_key = platform_sub.add_parser("refresh-key", help="抓取最新的 kugou_key.xz")
            refresh_key.add_argument("--output", help="保存新的 kugou_key.xz 路径")
        else:
            dec.add_argument("--format-ncm", choices=supported_transcode_formats(), help="ncm 输出格式")
        cover_group = dec.add_mutually_exclusive_group()
        cover_group.add_argument("--embed-cover", dest="embed_cover_art", action="store_true", help="自动补封面（所有平台共用），可能会导致转换变慢")
        cover_group.add_argument("--no-embed-cover", dest="embed_cover_art", action="store_false", help="不自动补封面")
        transcode_group = dec.add_mutually_exclusive_group()
        transcode_group.add_argument("--transcode", dest="transcode_enabled", action="store_true", help="转码为目标格式")
        transcode_group.add_argument("--no-transcode", dest="transcode_enabled", action="store_false", help="不转码，直接输出解密后的原始音频格式")
        album_group = dec.add_mutually_exclusive_group()
        album_group.add_argument("--supplement-album", dest="supplement_album_metadata", action="store_true", help="补充专辑信息（m4a/wav）")
        album_group.add_argument("--no-supplement-album", dest="supplement_album_metadata", action="store_false", help="不补充专辑信息")
        dec.set_defaults(embed_cover_art=None, supplement_album_metadata=None, transcode_enabled=None)
    transcode_parser = sub.add_parser("transcode-batch", help="执行批量转码")
    transcode_parser.add_argument("--input", action="append", help="输入文件或目录，可重复传入")
    transcode_parser.add_argument("--output", help="输出目录")
    transcode_parser.add_argument("--no-recursive", action="store_true", help="禁用递归扫描")
    transcode_parser.add_argument("--max-workers", type=int, choices=[1, 2, 3, 4], help="并发转码任务数，1-4")
    transcode_parser.add_argument("--rule", action="append", help="规则格式：<source>:<target>[:sample_rate_hz[:bitrate_kbps]]，例如 全部:m4a:48000:256")
    return parser


def main(argv: list[str] | None = None) -> int:
    if argv is None and len(sys.argv) == 1:
        admin_code = _require_admin(interactive=True)
        if admin_code is not None:
            return admin_code
        return run_interactive()
    paths = RuntimePaths.discover()
    parser = build_parser(paths)
    args = parser.parse_args(argv)
    if args.platform is None:
        admin_code = _require_admin(interactive=True)
        if admin_code is not None:
            return admin_code
        return run_interactive()
    _, config = load_config(paths)
    if args.platform == "transcode-batch":
        return _run_transcode_batch_cli(paths, config, args)
    if args.platform == "kugou" and args.command == "refresh-key":
        return _run_kugou_refresh_key_cli(paths, config, args)
    if args.command != "decrypt":
        parser.print_help()
        return 1
    admin_code = _require_admin(interactive=False)
    if admin_code is not None:
        return admin_code
    platform_id = args.platform
    settings = dict(config[platform_id])
    if args.transcode_enabled is not None:
        config["shared"]["transcode_enabled"] = bool(args.transcode_enabled)
    if args.embed_cover_art is not None:
        config["shared"]["embed_cover_art"] = bool(args.embed_cover_art)
    if args.supplement_album_metadata is not None:
        config["shared"]["supplement_album_metadata"] = bool(args.supplement_album_metadata)
    if getattr(args, "sample_rate", None) is not None:
        settings["transcode_sample_rate_hz"] = int(args.sample_rate)
    if getattr(args, "bitrate", None) is not None:
        settings["transcode_bitrate_kbps"] = int(args.bitrate)
    if platform_id == "qq":
        rules = dict(settings.get("format_rules", {}))
        for source_key, attr_name in (("mflac", "format_mflac"), ("mgg", "format_mgg"), ("mmp4", "format_mmp4")):
            value = getattr(args, attr_name)
            if value:
                rules[source_key] = validate_target_format(value)
        settings["format_rules"] = rules
    elif platform_id == "kuwo":
        if args.format_kwm:
            settings["format_kwm"] = validate_target_format(args.format_kwm)
        if args.exe_path:
            settings["exe_path"] = args.exe_path
        if args.signature_file:
            settings["signature_file"] = args.signature_file
        elif not str(settings.get("signature_file", "")).strip():
            settings["signature_file"] = str(default_kuwo_signature_path(paths))
    elif platform_id == "kugou":
        if args.kgg_db:
            settings["kgg_db_path"] = args.kgg_db
        if args.key_file:
            settings["key_file"] = args.key_file
        if args.format_kgma:
            settings["target_format_kgma"] = validate_target_format(args.format_kgma)
        if args.format_kgg:
            settings["target_format_kgg"] = validate_target_format(args.format_kgg)
    else:
        if args.format_ncm:
            settings["target_format_ncm"] = validate_target_format(args.format_ncm)
    config[platform_id].update(settings)
    recursive = not args.no_recursive
    return _run_platform(platform_id, config, input_override=args.input, output_override=args.output, recursive_override=recursive, interactive=False)


__all__ = [
    "PLATFORM_LABELS", "is_running_as_admin", "pause_exit", "choose_platform",
    "collision_prompt", "build_transcode_confirmation_resolver",
    "run_interactive", "main", "build_parser", "parse_transcode_rule_spec", "_run_platform",
]
