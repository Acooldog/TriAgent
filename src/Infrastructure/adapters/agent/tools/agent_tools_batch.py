"""Agent decrypt batch runner — 通用批量解密驱动。

从 agent_tools_decrypt.py 拆出，提供：
- _emit_batch_event: 批量事件上报
- run_decrypt_batch: 通用批量解密流程（plan → 循环解密 → 标记 → 保存索引）

优化：
- 返回值精简：成功只汇总数字，失败返回详情供模型处理
- 支持 post_process 回调：单个文件解密后立即处理（格式转换/采样率调整等）
"""
from __future__ import annotations

import pathlib
from typing import Any, Callable

from src.Infrastructure.adapters.agent.tools.agent_tools_state import (
    _get_event_sink,
    tool,
)
from src.Infrastructure.adapters.storage.file_catalog import iter_supported_files
from src.Infrastructure.adapters.storage.processed_index import (
    INDEX_FILENAME,
    mark_processed,
    plan_files,
    save_index,
)


def emit_batch_event(event_type: str, payload: dict) -> None:
    sink = _get_event_sink()
    if sink is None:
        return
    try:
        sink(event_type, payload)
    except Exception as exc:
        print(f"[batch-event] emit {event_type} failed: {exc}")


def run_decrypt_batch(
    files_to_decrypt: list[pathlib.Path],
    decrypt_one: Callable[[pathlib.Path], tuple[str | None, str]],
    log_prefix: str,
    empty_msg: str,
    platform_id: str = "",
    input_path: str = "",
    output_dir: str = "",
    target_format: str | None = None,
    post_process: Callable[[str, str, pathlib.Path], str | None] | None = None,
) -> str:
    """通用批量解密驱动：plan_files → 循环解密 → mark_processed → save_index。

    优化：成功只返回摘要（数字），失败返回详情供模型处理。
    支持 post_process 回调：单个文件解密后立即处理（格式转换/采样率调整等）。

    Args:
        files_to_decrypt: 已收集的待解密文件列表
        decrypt_one: 对单个文件执行解密的回调，返回 (output_path, container) 或 (None, "bin")
        log_prefix: 日志前缀，如 "[decrypt_kugou]"
        empty_msg: 无可处理文件时的返回消息
        platform_id: 平台标识（batch 事件上报用）
        input_path: 输入路径（batch 事件上报用）
        output_dir: 输出目录（batch 事件上报用 + 去重判断）
        target_format: 目标输出格式（去重判断，允许同一源文件输出到不同格式）
        post_process: 可选的后处理回调 (output_path, container, dst_root) -> new_output_path or None
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
        return (
            f"所有 {len(skipped)} 个文件均已在 {INDEX_FILENAME} 中记录，解密结果已存在于 {output_dir}，"
            f"无需重复解密。可继续调用 transcode_audio 对 {output_dir} 中的文件执行格式转换。"
        )

    total = len(pending)
    emit_batch_event("batch_started", {
        "platform_id": platform_id,
        "input_path": input_path,
        "output_dir": output_dir,
        "candidate_count": total,
        "kind": "decrypt",
    })

    failed_details: list[str] = []
    success = 0
    failed = 0
    for i, item in enumerate(pending, 1):
        file_path: pathlib.Path = item["file"]
        index: dict = item["index"]
        index_dir: pathlib.Path = item["index_dir"]
        index_path: pathlib.Path = item["index_path"]
        print(f"{log_prefix} 开始处理: {file_path.name}")
        emit_batch_event("file_started", {
            "index": i,
            "total": total,
            "input_path": str(file_path),
        })
        try:
            out_path, container = decrypt_one(file_path)
            if not out_path:
                failed_details.append(f"  失败: {file_path.name} - 未识别的音频容器")
                failed += 1
                emit_batch_event("file_finished", {
                    "index": i, "total": total,
                    "input_path": str(file_path),
                    "result": "failed",
                })
                continue

            # 后处理：解密成功后立即执行用户要求的格式转换/采样率调整等
            final_out = out_path
            if post_process is not None:
                processed = post_process(out_path, container, pathlib.Path(output_dir) if output_dir else file_path.parent)
                if processed:
                    final_out = processed

            success += 1
            print(f"{log_prefix} 成功: {file_path.name} -> {container}" + (f" → 后处理完成" if post_process else ""))
            mark_processed(index, file_path, index_dir, final_out, container)
            save_index(index_path, index)
            emit_batch_event("file_finished", {
                "index": i, "total": total,
                "input_path": str(file_path),
                "result": "ok",
            })
        except Exception as exc:
            failed_details.append(f"  失败: {file_path.name} - {exc}")
            failed += 1
            print(f"{log_prefix} 失败: {file_path.name} - {exc}")
            emit_batch_event("file_finished", {
                "index": i, "total": total,
                "input_path": str(file_path),
                "result": "failed",
            })

    skipped_count = len(skipped)
    header = f"解密完成：共 {total} 个待处理，成功 {success}，失败 {failed}，跳过 {skipped_count}"
    print(f"{log_prefix} {header}")

    emit_batch_event("batch_finished", {
        "platform_id": platform_id,
        "candidate_count": total,
        "success_count": success,
        "failed_count": failed,
        "skipped_count": skipped_count,
        "result_code": "ok" if failed == 0 else "partial",
        "kind": "decrypt",
    })

    # 精简返回：成功只摘要，失败全列出
    parts = [header]
    if failed_details:
        parts.append("\n失败详情：")
        parts.extend(failed_details)
        parts.append("\n请分析以上失败原因，尝试调整参数或跳过失败文件继续处理。")
    else:
        parts.append("全部成功。")
    return "\n".join(parts)


__all__ = [
    "emit_batch_event",
    "run_decrypt_batch",
]