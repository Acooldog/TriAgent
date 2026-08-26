"""多 Agent 调度器（主 Agent）。

职责: 调度时序 + 并发控制 + 事件转发
- Feature Flag: MULTI_AGENT_ENABLED — 用户可关闭降级为单 Agent
- 阶段: decrypt(串行, QQ 锁) → transcode(并行) → verify(并行)
- 纯调度，不做规划/汇总（委托 task_planner.py）
"""

from __future__ import annotations

import concurrent.futures
import logging
import threading
import time
from typing import Any, Callable

from src.Infrastructure.adapters.agent.multi.sub_agent import run_sub_agent
from src.Infrastructure.adapters.agent.multi.task_planner import (
    all_completed,
    aggregate_results,
    plan_tasks,
)
from src.Infrastructure.adapters.agent.multi.tool_registry import get_tools_by_role

logger = logging.getLogger("qkkdecrypt.infrastructure.multi_agent.orchestrator")

# ============== Feature Flag ==============
MULTI_AGENT_ENABLED: bool = True

# QQ 解密全局锁（Frida hook 必须串行）
_QQ_DECRYPT_LOCK = threading.Lock()

# 超时与并发配置
SUB_AGENT_TIMEOUT = 600
MAX_PARALLEL_TRANSCODE = 4
MAX_PARALLEL_VERIFY = 6


def set_multi_agent_enabled(enabled: bool) -> None:
    global MULTI_AGENT_ENABLED
    MULTI_AGENT_ENABLED = bool(enabled)
    logger.info(f"[Orchestrator] 多 Agent 模式 {'已开启' if enabled else '已关闭'}")


def _is_qq_task(task: dict[str, Any]) -> bool:
    desc = str(task.get("task", "")).lower()
    return ("qq" in desc) or (task.get("platform") == "qq")


class OrchestratorAgent:
    """多 Agent 协作调度器。

    用法:
        orch = OrchestratorAgent(model_config, event_sink)
        if orch.is_enabled():
            result = orch.run(user_request)
        else:
            # 降级为单 Agent
    """

    def __init__(
        self,
        model_config: dict[str, Any],
        event_sink: Callable[[str, dict[str, Any]], None],
        stop_requested: Callable[[], bool] | None = None,
    ) -> None:
        self.model_config = model_config
        self._sink = event_sink
        self._stop_requested = stop_requested

    @classmethod
    def is_enabled(cls) -> bool:
        return MULTI_AGENT_ENABLED

    # ============== 事件 ==============
    def _emit(self, event_type: str, payload: dict[str, Any] | None = None) -> None:
        payload = dict(payload or {})
        payload.setdefault("orchestrator", True)
        try:
            self._sink(event_type, payload)
        except Exception:
            pass

    # ============== 主入口 ==============
    def run(self, user_request: str) -> dict[str, Any]:
        if not MULTI_AGENT_ENABLED:
            self._emit("orchestrator_info", {"message": "多 Agent 未启用，走单 Agent"})
            return {"status": "skipped", "reason": "multi_agent_disabled"}

        self._emit("orchestrator_started", {"message": user_request[:100]})
        tasks = plan_tasks(user_request)
        if not tasks:
            self._emit("orchestrator_info", {"message": "无法规划流水线，降级为单 Agent"})
            return {"status": "skipped", "reason": "no_plan"}

        decrypt_tasks = [t for t in tasks if t["parallel_group"] == "decrypt"]
        transcode_tasks = [t for t in tasks if t["parallel_group"] == "transcode"]
        verify_tasks = [t for t in tasks if t["parallel_group"] == "verify"]

        start = time.perf_counter()

        # Phase 1: 解密
        self._emit("orchestrator_phase_started", {"phase": "decrypt", "count": len(decrypt_tasks)})
        decrypt_results = self._run_decrypt(decrypt_tasks)
        if not all_completed(decrypt_results):
            self._emit("orchestrator_info", {"message": "解密未全部完成，继续处理已有结果"})

        # Phase 2: 转码
        transcode_results = []
        if transcode_tasks:
            self._emit("orchestrator_phase_started", {"phase": "transcode", "count": len(transcode_tasks)})
            transcode_results = self._run_parallel(transcode_tasks, MAX_PARALLEL_TRANSCODE)

        # Phase 3: 验证
        verify_results = []
        if verify_tasks:
            self._emit("orchestrator_phase_started", {"phase": "verify", "count": len(verify_tasks)})
            verify_results = self._run_parallel(verify_tasks, MAX_PARALLEL_VERIFY)

        elapsed = round(time.perf_counter() - start, 3)
        all_results = decrypt_results + transcode_results + verify_results
        summary = aggregate_results(all_results)

        self._emit("orchestrator_finished", {
            "status": summary["overall"], "total": len(all_results),
            "completed": summary["completed"], "failed": summary["failed"],
            "elapsed_sec": elapsed,
        })

        return {
            "status": summary["overall"], "elapsed_sec": elapsed,
            "phases": {"decrypt": decrypt_results, "transcode": transcode_results, "verify": verify_results},
            "summary": summary,
        }

    # ============== 阶段执行 ==============
    def _run_decrypt(self, tasks: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """解密：QQ 任务在全局锁内串行。"""
        results: list[dict[str, Any]] = []
        for idx, task in enumerate(tasks):
            agent_id = f"decrypt-{idx+1}"
            if _is_qq_task(task):
                self._emit("orchestrator_waiting_lock", {"agent_id": agent_id, "lock": "qq_decrypt"})
                with _QQ_DECRYPT_LOCK:
                    self._emit("orchestrator_lock_acquired", {"agent_id": agent_id, "lock": "qq_decrypt"})
                    results.append(self._dispatch(agent_id, task))
                    self._emit("orchestrator_lock_released", {"agent_id": agent_id, "lock": "qq_decrypt"})
            else:
                results.append(self._dispatch(agent_id, task))
        return results

    def _run_parallel(self, tasks: list[dict[str, Any]], max_workers: int) -> list[dict[str, Any]]:
        """并行阶段：ThreadPool 同时跑多个子 Agent。"""
        results: list[dict[str, Any]] = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as pool:
            futures = {
                pool.submit(self._dispatch, f"{t['role']}-{i+1}", t): f"{t['role']}-{i+1}"
                for i, t in enumerate(tasks)
            }
            for future in concurrent.futures.as_completed(futures):
                agent_id = futures[future]
                try:
                    result = future.result(timeout=SUB_AGENT_TIMEOUT + 60)
                except concurrent.futures.TimeoutError:
                    result = {"agent_id": agent_id, "status": "timeout"}
                except Exception as exc:
                    result = {"agent_id": agent_id, "status": "failed", "error": str(exc)[:200]}
                results.append(result)
                self._emit("orchestrator_sub_agent_done", {"agent_id": agent_id, "status": result.get("status")})
        return results

    def _dispatch(self, agent_id: str, task: dict[str, Any]) -> dict[str, Any]:
        """派发单个子 Agent。"""
        role = task["role"]
        tools = get_tools_by_role(role)
        if not tools:
            return {"agent_id": agent_id, "role": role, "status": "skipped", "reason": "no_tools"}
        logger.info(f"[Orchestrator] 派发 {agent_id} role={role}")
        try:
            return run_sub_agent(
                agent_id=agent_id, role=role,
                task_description=task.get("task", ""), tools=tools,
                model_config=self.model_config, event_sink=self._sink,
                max_iterations=8, timeout=SUB_AGENT_TIMEOUT,
                stop_requested=self._stop_requested,
            )
        except Exception as exc:
            logger.error(f"[Orchestrator] {agent_id} 异常: {exc}")
            return {"agent_id": agent_id, "role": role, "status": "failed", "error": str(exc)[:300]}
