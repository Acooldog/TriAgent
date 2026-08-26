"""多 Agent 任务规划 & 结果汇总。

职责:
- plan_tasks: 把用户请求拆分为子任务（规则驱动，无 LLM 幻觉）
- aggregate_results: 汇总子 Agent 执行结果

设计:
- 纯函数（无状态），便于测试和复用
- 与 orchestrator 解耦，未来可替换为 LLM 规划
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger("qkkdecrypt.infrastructure.multi_agent.task_planner")


def detect_platform(normalized_request: str) -> str:
    """从用户请求中检测涉及哪些加密平台。"""
    platforms = []
    if any(k in normalized_request for k in ("kgma", "kgm", "kgg", "vpr", "酷狗", "kugou")):
        platforms.append("kugou")
    if any(k in normalized_request for k in ("mflac", "mgg", "mmp4", "qq")):
        platforms.append("qq")
    if "ncm" in normalized_request or "网易云" in normalized_request:
        platforms.append("netease")
    if "kwm" in normalized_request or "酷我" in normalized_request:
        platforms.append("kuwo")
    return ",".join(platforms) if platforms else "auto"


def plan_tasks(user_request: str) -> list[dict[str, Any]]:
    """规则驱动拆分用户请求为子任务列表。

    返回空列表表示无法识别为流水线，调用方应降级为单 Agent。
    每个任务 dict: {role, task, platform, parallel_group}
    """
    normalized = user_request.lower()

    decrypt_kw = ("解密", "kgma", "kgm", "kgg", "vpr", "mflac", "mgg", "mmp4", "ncm", "kwm", "加密")
    transcode_kw = ("转换", "转码", "转成", "格式", "mp3", "m4a", "flac", "wav", "ogg", "压缩")
    verify_kw = ("校验", "验证", "损坏", "检查", "完整性", "修复")

    needs_decrypt = any(k in normalized for k in decrypt_kw)
    needs_transcode = any(k in normalized for k in transcode_kw)
    needs_verify = any(k in normalized for k in verify_kw)
    full_pipeline = needs_decrypt and needs_transcode

    if not (needs_decrypt or needs_transcode or needs_verify):
        logger.info("[task_planner] 无法识别为标准流水线")
        return []

    tasks: list[dict[str, Any]] = []

    if needs_decrypt:
        tasks.append({
            "role": "decrypt",
            "task": f"扫描并解密指定目录的加密音乐文件: {user_request[:80]}",
            "parallel_group": "decrypt",
            "platform": detect_platform(normalized),
        })

    if full_pipeline or needs_transcode:
        tasks.append({
            "role": "transcode",
            "task": f"把解密后的音频文件转换为目标格式: {user_request[:80]}",
            "parallel_group": "transcode",
        })

    if needs_verify or full_pipeline:
        tasks.append({
            "role": "verify",
            "task": f"校验最终输出的音频文件完整性: {user_request[:80]}",
            "parallel_group": "verify",
        })

    logger.info(f"[task_planner] 规划完成: {len(tasks)} 个子任务")
    for t in tasks:
        logger.info(f"  [{t['parallel_group']}] role={t['role']} platform={t.get('platform', '-')}")
    return tasks


def aggregate_results(results: list[dict[str, Any]]) -> dict[str, Any]:
    """汇总子 Agent 执行结果。

    Returns: {"overall": "success/partial/failed/empty", "total", "completed", "failed", "skipped"}
    """
    completed = sum(1 for r in results if r.get("status") == "completed")
    failed = sum(1 for r in results if r.get("status") in ("failed", "timeout"))
    skipped = sum(1 for r in results if r.get("status") == "skipped")
    total = len(results)

    if total == 0:
        overall = "empty"
    elif failed == 0:
        overall = "success"
    elif completed > 0:
        overall = "partial"
    else:
        overall = "failed"

    return {
        "overall": overall,
        "total": total,
        "completed": completed,
        "failed": failed,
        "skipped": skipped,
    }


def all_completed(results: list[dict[str, Any]]) -> bool:
    return all(r.get("status") == "completed" for r in results) if results else True
