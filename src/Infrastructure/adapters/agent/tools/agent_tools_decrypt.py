from __future__ import annotations

import pathlib
from typing import Any, Callable

from src.Infrastructure.adapters.agent.tools.agent_tools_state import (
    _find_kgg_db,
    _find_kugou_key,
    _get_event_sink,
    _to_path,
    tool,
)
from src.Infrastructure.adapters.storage.file_catalog import iter_supported_files
from src.Infrastructure.adapters.platforms.kugou.decoder.kugou_decoder import decode_file
from src.Infrastructure.adapters.storage.processed_index import (
    INDEX_FILENAME,
    mark_processed,
    plan_files,
    save_index,
)


def _emit_batch_event(event_type: str, payload: dict) -> None:
    sink = _get_event_sink()
    if sink is None:
        return
    try:
        sink(event_type, payload)
    except Exception as exc:
        print(f"[batch-event] emit {event_type} failed: {exc}")


def _run_decrypt_batch(
    files_to_decrypt: list[pathlib.Path],
    decrypt_one: Callable[[pathlib.Path], tuple[str | None, str]],
    log_prefix: str,
    empty_msg: str,
    platform_id: str = "",
    input_path: str = "",
    output_dir: str = "",
    target_format: str | None = None,
) -> str:
    """通用批量解密驱动：plan_files → 循环解密 → mark_processed → save_index。

    Args:
        files_to_decrypt: 已收集的待解密文件列表
        decrypt_one: 对单个文件执行解密的回调，返回 (output_path, container) 或 (None, "bin")
        log_prefix: 日志前缀，如 "[decrypt_kugou]"
        empty_msg: 无可处理文件时的返回消息
        platform_id: 平台标识（batch 事件上报用）
        input_path: 输入路径（batch 事件上报用）
        output_dir: 输出目录（batch 事件上报用 + 去重判断）
        target_format: 目标输出格式（去重判断，允许同一源文件输出到不同格式）
    """
    if not files_to_decrypt:
        return empty_msg

    print(f"{log_prefix} 待解密文件 {len(files_to_decrypt)} 个")
    pending, skipped = plan_files(
        files_to_decrypt,
        output_dir=output_dir if output_dir else None,
        target_format=target_format,
    )
    if skipped:
        print(f"{log_prefix} 跳过已处理文件 {len(skipped)} 个（见 {INDEX_FILENAME}）")
    if not pending:
        return f"所有 {len(skipped)} 个文件均已处理过（见 {INDEX_FILENAME}），本次跳过。"

    total = len(pending)
    _emit_batch_event("batch_started", {
        "platform_id": platform_id,
        "input_path": input_path,
        "output_dir": output_dir,
        "candidate_count": total,
        "kind": "decrypt",
    })

    results: list[str] = []
    success = 0
    failed = 0
    for i, item in enumerate(pending, 1):
        file_path: pathlib.Path = item["file"]
        index: dict = item["index"]
        index_dir: pathlib.Path = item["index_dir"]
        index_path: pathlib.Path = item["index_path"]
        print(f"{log_prefix} 开始处理: {file_path.name}")
        _emit_batch_event("file_started", {
            "index": i,
            "total": total,
            "input_path": str(file_path),
        })
        try:
            out_path, container = decrypt_one(file_path)
            if out_path:
                results.append(f"  成功: {file_path.name} -> {out_path} [{container}]")
                success += 1
                print(f"{log_prefix} 成功: {file_path.name} -> {container}")
                mark_processed(index, file_path, index_dir, str(out_path), container)
                save_index(index_path, index)
                _emit_batch_event("file_finished", {
                    "index": i, "total": total,
                    "input_path": str(file_path),
                    "result": "ok",
                })
            else:
                results.append(f"  失败: {file_path.name} - 未识别的音频容器")
                failed += 1
                _emit_batch_event("file_finished", {
                    "index": i, "total": total,
                    "input_path": str(file_path),
                    "result": "failed",
                })
        except Exception as exc:
            results.append(f"  失败: {file_path.name} - {exc}")
            failed += 1
            print(f"{log_prefix} 失败: {file_path.name} - {exc}")
            _emit_batch_event("file_finished", {
                "index": i, "total": total,
                "input_path": str(file_path),
                "result": "failed",
            })

    header = f"解密完成：共 {len(pending)} 个待处理，成功 {success}，失败 {failed}，跳过 {len(skipped)}"
    print(f"{log_prefix} {header}")

    _emit_batch_event("batch_finished", {
        "platform_id": platform_id,
        "candidate_count": total,
        "success_count": success,
        "failed_count": failed,
        "skipped_count": len(skipped),
        "result_code": "ok" if failed == 0 else "partial",
        "kind": "decrypt",
    })

    return header + "\n" + "\n".join(results)


@tool
def scan_files(directory: str, recursive: bool = True, file_types: str = "kugou") -> str:
    """扫描指定目录下的加密音乐文件。
    Args: directory: 要扫描的目录路径, recursive: 是否递归扫描子目录，默认为 True, file_types: 文件类型过滤，支持 "kugou"（酷狗格式）与 "qq"（QQ音乐格式）
    """
    try:
        input_path = _to_path(directory)
        if not input_path.exists():
            return f"错误：目录不存在 - {directory}"
        if not input_path.is_dir():
            return f"错误：路径不是目录 - {directory}"
        files = iter_supported_files(input_path, recursive)
        if not files:
            return f"在 {directory} 中未找到加密音乐文件"
        by_type: dict[str, list[str]] = {}
        for f in files:
            ext = f.suffix.lower()
            if ext not in by_type:
                by_type[ext] = []
            by_type[ext].append(str(f))
        parts = [f"在 {directory} 中找到 {len(files)} 个加密文件:"]
        for ext, paths in sorted(by_type.items()):
            parts.append(f"\n  {ext}: {len(paths)} 个")
            for p in paths[:10]:
                parts.append(f"    - {p}")
            if len(paths) > 10:
                parts.append(f"    ... 还有 {len(paths) - 10} 个")
        return "\n".join(parts)
    except Exception as exc:
        return f"扫描失败：{exc}"


@tool
def decrypt_kugou(input_path: str, output_dir: str, target_format: str = "auto") -> str:
    """解密酷狗音乐加密文件（kgma/kgm/kgg/vpr），输出为可播放的音频文件。
    Args: input_path: 加密文件或包含加密文件的目录路径, output_dir: 解密后音频文件的输出目录, target_format: 输出格式，可选 "auto"、"flac"、"m4a"、"mp3"、"wav"
    """
    try:
        src = _to_path(input_path)
        dst = _to_path(output_dir)
        dst.mkdir(parents=True, exist_ok=True)
        if not src.exists():
            return f"错误：输入路径不存在 - {input_path}"
        key_file = _find_kugou_key()
        if key_file is None:
            return "错误：未找到 kugou_key.xz 公钥文件，请确保 assets 目录下存在该文件"
        files_to_decrypt = [src] if src.is_file() else iter_supported_files(src, True)

        def _decrypt_one(fp: pathlib.Path) -> tuple[str | None, str]:
            summary = decode_file(fp, dst, key_path=key_file, kgg_db_path=_find_kgg_db() or pathlib.Path())
            return summary.get("output_path"), summary.get("detected_container", "bin")

        return _run_decrypt_batch(
            files_to_decrypt, _decrypt_one,
            log_prefix="[decrypt_kugou]",
            empty_msg=f"在 {input_path} 中未找到酷狗加密文件",
            platform_id="kugou", input_path=input_path, output_dir=str(dst),
            target_format=None if target_format == "auto" else target_format,
        )
    except Exception as exc:
        return f"解密失败：{exc}"


@tool
def decrypt_qq(input_path: str, output_dir: str) -> str:
    """解密 QQ 音乐加密文件（mflac/mgg/mmp4），输出为可播放的音频文件。需要 QQ 音乐客户端已运行。
    Args: input_path: 加密文件或包含加密文件的目录路径, output_dir: 解密后音频文件的输出目录
    """
    try:
        src = _to_path(input_path)
        dst = _to_path(output_dir)
        dst.mkdir(parents=True, exist_ok=True)
        if not src.exists():
            return f"错误：输入路径不存在 - {input_path}"
        print(f"[decrypt_qq] 输入: {src} | 输出: {dst}")
        try:
            from src.Infrastructure.adapters.platforms.registry import build_platform_adapter
        except ImportError as exc:
            return f"错误：QQ 音乐解密运行时不可用 - {exc}"
        adapter = build_platform_adapter("qq")
        ok, _reason = adapter.validate_runtime({"process_match": "qqmusic", "auto_start": True})
        if not ok:
            return f"错误：{_reason or '未检测到运行中的 QQ 音乐客户端，自动启动也未成功。'}"
        print("[decrypt_qq] 运行时校验通过，QQ 音乐进程已就绪")
        files_to_decrypt = adapter.collect_files(src, True)

        def _decrypt_one(fp: pathlib.Path) -> tuple[str | None, str]:
            summary = adapter.decrypt_one(fp, dst, {"format_rules": {"mflac": "flac", "mgg": "m4a", "mmp4": "m4a"}}, log_dir=dst)
            return summary.get("output_path"), summary.get("detected_container", "bin")

        return _run_decrypt_batch(
            files_to_decrypt, _decrypt_one,
            log_prefix="[decrypt_qq]",
            empty_msg=f"在 {input_path} 中未找到 QQ 音乐加密文件（mflac/mgg/mmp4）",
            platform_id="qq", input_path=input_path, output_dir=str(dst),
        )
    except Exception as exc:
        return f"解密失败：{exc}"


@tool
def decrypt_netease(input_path: str, output_dir: str) -> str:
    """解密网易云音乐加密文件（ncm 格式），输出为可播放的音频文件。无需运行网易云音乐客户端。
    Args: input_path: 加密文件或包含加密文件的目录路径, output_dir: 解密后音频文件的输出目录
    """
    try:
        src = _to_path(input_path)
        dst = _to_path(output_dir)
        dst.mkdir(parents=True, exist_ok=True)
        if not src.exists():
            return f"错误：输入路径不存在 - {input_path}"
        print(f"[decrypt_netease] 输入: {src} | 输出: {dst}")
        try:
            from src.Infrastructure.adapters.platforms.registry import build_platform_adapter
        except ImportError as exc:
            return f"错误：网易云解密运行时不可用 - {exc}"
        adapter = build_platform_adapter("netease")
        ok, _reason = adapter.validate_runtime({})
        if not ok:
            return "错误：网易云解密运行时校验失败。"
        print("[decrypt_netease] 运行时校验通过")
        files_to_decrypt = adapter.collect_files(src, True)

        def _decrypt_one(fp: pathlib.Path) -> tuple[str | None, str]:
            summary = adapter.decrypt_one(fp, dst, {}, log_dir=dst)
            return summary.get("output_path"), summary.get("detected_container", "bin")

        return _run_decrypt_batch(
            files_to_decrypt, _decrypt_one,
            log_prefix="[decrypt_netease]",
            empty_msg=f"在 {input_path} 中未找到网易云音乐加密文件（ncm）",
            platform_id="netease", input_path=input_path, output_dir=str(dst),
        )
    except Exception as exc:
        return f"解密失败：{exc}"


@tool
def decrypt_kuwo(input_path: str, output_dir: str) -> str:
    """解密酷我音乐加密文件（kwm 格式），输出为可播放的音频文件。无需运行酷我音乐客户端。
    Args: input_path: 加密文件或包含加密文件的目录路径, output_dir: 解密后音频文件的输出目录
    """
    try:
        from src.Infrastructure.adapters.platforms.kuwo.unlockmusic_decoder import decrypt_kwm_file

        src = _to_path(input_path)
        dst = _to_path(output_dir)
        dst.mkdir(parents=True, exist_ok=True)
        if not src.exists():
            return f"错误：输入路径不存在 - {input_path}"
        print(f"[decrypt_kuwo] 输入: {src} | 输出: {dst}")
        KWM_SUFFIX = ".kwm"
        if src.is_file():
            files = [src] if src.suffix.lower() == KWM_SUFFIX else []
        else:
            files = sorted(p for p in src.rglob("*") if p.is_file() and p.suffix.lower() == KWM_SUFFIX)

        def _decrypt_one(fp: pathlib.Path) -> tuple[str | None, str]:
            final_path, ext = decrypt_kwm_file(fp, dst / fp.stem)
            return str(final_path), ext

        return _run_decrypt_batch(
            files, _decrypt_one,
            log_prefix="[decrypt_kuwo]",
            empty_msg=f"在 {input_path} 中未找到酷我音乐加密文件（kwm）",
            platform_id="kuwo", input_path=input_path, output_dir=str(dst),
        )
    except Exception as exc:
        return f"解密失败：{exc}"


__all__ = [
    "_run_decrypt_batch",
    "scan_files",
    "decrypt_kugou",
    "decrypt_qq",
    "decrypt_netease",
    "decrypt_kuwo",
]
