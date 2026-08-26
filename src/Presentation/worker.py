from __future__ import annotations

import contextlib
import json
import pathlib
import sys
import threading
import time
from datetime import datetime, timezone
from typing import Any

PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

PROTOCOL_VERSION = "1"

for _stream in (sys.stdout, sys.stderr):
    _reconfigure = getattr(_stream, "reconfigure", None)
    if callable(_reconfigure):
        _reconfigure(encoding="utf-8", errors="strict")


class WorkerRequestError(ValueError):
    pass


class WorkerRuntime:
    def __init__(self, request_id: str, task_id: str) -> None:
        self.request_id = request_id
        self.task_id = task_id
        self.cancelled = threading.Event()
        self._write_lock = threading.Lock()
        self._output = sys.stdout

    def emit(self, event_type: str, status: str = "running", payload: dict[str, Any] | None = None, error: dict[str, Any] | None = None) -> None:
        event = {
            "protocol_version": PROTOCOL_VERSION,
            "request_id": self.request_id,
            "task_id": self.task_id,
            "event_type": event_type,
            "status": status,
            "payload": payload or {},
            "error": error,
            "emitted_at": datetime.now(timezone.utc).isoformat(),
        }
        with self._write_lock:
            self._output.write(json.dumps(event, ensure_ascii=False, separators=(",", ":"), default=str) + "\n")
            self._output.flush()

    def log(self, message: str, level: str = "info") -> None:
        self.emit("agent_log", payload={
            "level": level,
            "message": message,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })


def parse_start(line: str) -> dict[str, Any]:
    try:
        value = json.loads(line)
    except json.JSONDecodeError as exc:
        raise WorkerRequestError("启动请求不是有效 JSON。") from exc
    if not isinstance(value, dict) or value.get("protocol_version") != PROTOCOL_VERSION or value.get("command") != "start":
        raise WorkerRequestError("启动请求协议无效。")
    for key in ("request_id", "task_id", "operation"):
        if not isinstance(value.get(key), str) or not value[key].strip():
            raise WorkerRequestError(f"启动请求缺少 {key}。")
    if value["operation"] not in {"ping", "decrypt", "agent"}:
        raise WorkerRequestError("worker 操作类型不受支持。")
    if not isinstance(value.get("payload", {}), dict):
        raise WorkerRequestError("worker payload 必须是对象。")
    return value


def run_request(request: dict[str, Any], runtime: WorkerRuntime) -> int:
    runtime.emit("worker_started", payload={"operation": request["operation"]})
    try:
        if request["operation"] == "ping":
            runtime.emit("worker_finished", status="completed", payload={"result_code": 0, "message": "Python worker 已就绪。"})
            return 0
        if request["operation"] == "agent":
            return run_agent(request["payload"], runtime)
        return run_decrypt(request["payload"], runtime)
    except Exception as exc:
        runtime.emit("worker_finished", status="cancelled" if runtime.cancelled.is_set() else "failed", payload={"result_code": 3 if runtime.cancelled.is_set() else 1}, error={"code": "worker-runtime-error", "message": str(exc)})
        return 3 if runtime.cancelled.is_set() else 1


def run_decrypt(payload: dict[str, Any], runtime: WorkerRuntime) -> int:
    for key in ("platform", "input_path", "output_dir"):
        if not isinstance(payload.get(key), str) or not payload[key].strip():
            raise WorkerRequestError(f"decrypt payload 缺少 {key}。")
    from src.Application.decrypt_service import run_batch
    from src.Application.models import BatchRunConfig
    from src.Infrastructure.platforms.registry import build_platform_adapter
    platform_id = str(payload["platform"]).strip().lower()
    config = BatchRunConfig(
        platform_id=platform_id,
        input_path=pathlib.Path(str(payload["input_path"])),
        output_dir=pathlib.Path(str(payload["output_dir"])),
        recursive=bool(payload.get("recursive", True)),
        collision_policy=str(payload.get("collision_policy", "suffix")),
        settings=dict(payload.get("settings") or {}),
        event_sink=lambda name, data: runtime.emit(name, payload=data),
        stop_requested=runtime.cancelled.is_set,
    )
    with contextlib.redirect_stdout(sys.stderr):
        result_code = run_batch(config, build_platform_adapter(platform_id))
    status = "cancelled" if result_code == 3 or runtime.cancelled.is_set() else "completed" if result_code == 0 else "failed"
    runtime.emit("worker_finished", status=status, payload={"result_code": result_code})
    return result_code


def run_agent(payload: dict[str, Any], runtime: WorkerRuntime) -> int:
    runtime.log(f"收到 agent 请求，payload keys: {list(payload.keys())}")

    user_message = str(payload.get("message", "") or "").strip()
    if not user_message:
        raise WorkerRequestError("agent payload 缺少 message。")
    runtime.log(f"用户消息: {user_message[:100]}")

    model_config = dict(payload.get("model_config") or {})
    if not model_config:
        raise WorkerRequestError("agent payload 缺少 model_config。")
    runtime.log(f"模型配置: model={model_config.get('model')}, base_url={model_config.get('base_url', '')}")

    model_config.setdefault("model", "glm-4.5")
    model_config.setdefault("base_url", "https://open.bigmodel.cn/api/paas/v4")
    max_iterations = int(payload.get("max_iterations", 15) or 15)

    from src.Infrastructure.agent_progress import build_initial_action_message
    runtime.emit("agent_message", payload={
        "content": build_initial_action_message(user_message),
        "kind": "progress",
    })
    runtime.log("正在导入 agent_executor (步骤 1/3: 加载模块)...")
    import importlib
    runtime.log("正在导入 agent_executor (步骤 2/3: 执行 import)...")
    _agent_executor_mod = importlib.import_module("src.Infrastructure.agent_executor")
    runtime.log("正在导入 agent_executor (步骤 3/3: 获取引用)...")
    _run_agent = _agent_executor_mod.run_agent
    check_langchain_available = _agent_executor_mod.check_langchain_available
    runtime.log("agent_executor 导入完成")
    threading.Thread(target=read_cancel, args=(runtime,), daemon=True).start()

    langchain_ok = check_langchain_available()
    runtime.log(f"langchain 状态: {'已安装' if langchain_ok else '未安装'}")

    if not langchain_ok:
        runtime.log("langchain 未安装，发送错误事件")
        runtime.emit("agent_log", payload={"level": "error", "message": "langchain 未安装，请先运行: pip install langchain langchain-core langchain-community"})
        runtime.emit("agent_tool_call", payload={
            "tool_name": "system_check",
            "tool_input": "检查并安装 langchain 依赖",
            "tool_result": "请先运行: pip install langchain langchain-core langchain-community",
            "elapsed_sec": 0,
            "step": 0,
        })
        runtime.emit("agent_finished", status="failed", payload={
            "result_code": 1,
            "reason": "langchain_not_installed",
            "hint": "请运行: pip install langchain langchain-core langchain-community",
        })
        runtime.emit("worker_finished", status="failed", payload={"result_code": 1})
        return 1

    runtime.log("langchain 已就绪，开始执行 Agent")
    runtime.emit("agent_step_started", payload={"step": 1, "message": user_message[:100]})

    try:
        def event_sink(name: str, data: dict[str, Any]) -> None:
            runtime.emit(name, payload=data)

        runtime.log("调用 agent_executor.run_agent()...")
        with contextlib.redirect_stdout(sys.stderr):
            result = _run_agent(
                user_message=user_message,
                model_config=model_config,
                event_sink=event_sink,
                max_iterations=max_iterations,
                stop_requested=runtime.cancelled.is_set,
                announce_start=False,
            )
        runtime.log(f"Agent 执行完成，结果: status={result.get('status')}, response_len={len(str(result.get('response', '')))}")

        status = "completed" if result.get("status") == "completed" else "cancelled" if result.get("status") == "cancelled" else "failed"
        runtime.emit("agent_finished", payload={
            "status": status,
            "tool_calls_count": len(result.get("tool_calls", [])),
            "response_preview": str(result.get("response", ""))[:200],
        })
        runtime.emit("worker_finished", status=status, payload={
            "result_code": 0 if status == "completed" else 3 if status == "cancelled" else 1,
            "agent_result": result,
        })
        return 0 if status == "completed" else 3 if status == "cancelled" else 1

    except Exception as exc:
        import traceback
        tb = traceback.format_exc()
        runtime.log(f"Agent 执行异常: {exc}\n{tb}", level="error")
        runtime.emit("agent_log", payload={"level": "error", "message": f"Agent 异常: {exc}"})
        runtime.emit("agent_finished", status="failed", error={"code": "agent-runtime-error", "message": str(exc)})
        runtime.emit("worker_finished", status="failed", payload={"result_code": 1}, error={"code": "agent-runtime-error", "message": str(exc)})
        return 1


def read_cancel(runtime: WorkerRuntime) -> None:
    for line in sys.stdin:
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and value.get("command") == "cancel" and value.get("request_id") == runtime.request_id and value.get("task_id") == runtime.task_id:
            runtime.cancelled.set()
            return


def main() -> int:
    first_line = sys.stdin.readline()
    try:
        request = parse_start(first_line)
    except WorkerRequestError as exc:
        runtime = WorkerRuntime("invalid-request", "invalid-task")
        runtime.emit("worker_finished", status="failed", payload={"result_code": 1}, error={"code": "worker-request-error", "message": str(exc)})
        return 1
    runtime = WorkerRuntime(request["request_id"], request["task_id"])
    if request["operation"] != "agent":
        threading.Thread(target=read_cancel, args=(runtime,), daemon=True).start()
    return run_request(request, runtime)


if __name__ == "__main__":
    raise SystemExit(main())
