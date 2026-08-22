"""Public protocol probe for the Agent-only repository.

The public build exposes only the worker event contract. Optional capability
providers are assembled separately and are not part of this source tree.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from typing import Any

PROTOCOL_VERSION = "1"


def emit(request_id: str, task_id: str, event_type: str, status: str, payload: dict[str, Any] | None = None, error: dict[str, Any] | None = None) -> None:
    event = {
        "protocol_version": PROTOCOL_VERSION,
        "request_id": request_id,
        "task_id": task_id,
        "event_type": event_type,
        "status": status,
        "payload": payload or {},
        "error": error,
        "emitted_at": datetime.now(timezone.utc).isoformat(),
    }
    sys.stdout.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main() -> int:
    try:
        request = json.loads(sys.stdin.readline())
    except json.JSONDecodeError:
        emit("invalid-request", "invalid-task", "worker_finished", "failed", error={"code": "worker-request-error", "message": "worker request is not valid JSON"})
        return 1
    if not isinstance(request, dict):
        emit("invalid-request", "invalid-task", "worker_finished", "failed", error={"code": "worker-request-error", "message": "worker request must be an object"})
        return 1
    request_id = str(request.get("request_id") or "invalid-request")
    task_id = str(request.get("task_id") or "invalid-task")
    emit(request_id, task_id, "worker_started", "running", {"operation": request.get("operation")})
    if request.get("protocol_version") != PROTOCOL_VERSION or request.get("command") != "start":
        emit(request_id, task_id, "worker_finished", "failed", error={"code": "worker-request-error", "message": "worker request protocol is invalid"})
        return 1
    if request.get("operation") != "ping":
        emit(request_id, task_id, "worker_finished", "failed", error={"code": "capability-unavailable", "message": "optional capability provider is not included in the public build"})
        return 2
    emit(request_id, task_id, "worker_finished", "completed", {"result_code": 0, "message": "public worker protocol is ready"})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
