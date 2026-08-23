from __future__ import annotations

import contextlib
import json
import pathlib
import sys
import threading
from datetime import datetime, timezone
from typing import Any

PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

PROTOCOL_VERSION = "1"

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
    if value["operation"] not in {"ping", "decrypt"}:
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
    threading.Thread(target=read_cancel, args=(runtime,), daemon=True).start()
    return run_request(request, runtime)

if __name__ == "__main__":
    raise SystemExit(main())
