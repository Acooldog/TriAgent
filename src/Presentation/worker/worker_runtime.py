from __future__ import annotations

import json
import pathlib
import sys
import threading
import uuid
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


def _open_agent_logfile() -> Any:
    """为本次 worker 运行创建落盘日志文件，路径 _log/agent/{date}/agent_{time}.log。"""
    try:
        now = datetime.now()
        log_root = PROJECT_ROOT / "_log" / "agent" / f"{now.year}-{now.month}-{now.day}"
        log_root.mkdir(parents=True, exist_ok=True)
        log_path = log_root / f"agent_{now.strftime('%H-%M-%S')}.log"
        return log_path.open("a", encoding="utf-8")
    except Exception:
        return None


class WorkerRuntime:
    def __init__(self, request_id: str, task_id: str) -> None:
        self.request_id = request_id
        self.task_id = task_id
        self.cancelled = threading.Event()
        self.supplements: list[str] = []
        self._supplement_lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._output = sys.stdout
        self._log_file = _open_agent_logfile()
        self._log_path = getattr(self._log_file, "name", None)
        self._pending_questions: dict[str, dict[str, Any]] = {}
        self._question_lock = threading.Lock()

    ASK_USER_TIMEOUT_SEC = 600

    def ask_user(self, question: str, options: list[str]) -> str:
        """向用户提问并阻塞等待回答。返回用户所选内容；超时/取消返回兜底字符串。"""
        question_id = uuid.uuid4().hex
        done_event = threading.Event()
        record: dict[str, Any] = {
            "question": question,
            "options": list(options),
            "answer": None,
            "event": done_event,
        }
        with self._question_lock:
            self._pending_questions[question_id] = record
        self.log(f"向用户提问：{question[:100]}（选项 {len(options)} 个）", "info")
        self.emit("agent_question", payload={
            "question_id": question_id,
            "question": question,
            "options": list(options),
        })
        signaled = done_event.wait(timeout=self.ASK_USER_TIMEOUT_SEC)
        with self._question_lock:
            self._pending_questions.pop(question_id, None)
        if not signaled:
            self.log(f"用户提问超时（{self.ASK_USER_TIMEOUT_SEC}s）：{question[:80]}", "warning")
            return "用户未在超时时间内回答，请按最稳妥的方式继续"
        answer = record.get("answer")
        if answer is None:
            return "用户未回答"
        return str(answer)

    def provide_answer(self, question_id: str, answer: str) -> bool:
        """前端收到 agent_question 后调用此方法回填答案，唤醒阻塞的 ask_user。"""
        with self._question_lock:
            record = self._pending_questions.get(question_id)
            if not record:
                return False
            record["answer"] = answer
            record["event"].set()
        self.log(f"用户已回答提问 {question_id[:8]}：{answer[:80]}", "info")
        return True

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
        line = json.dumps(event, ensure_ascii=False, separators=(",", ":"), default=str)
        with self._write_lock:
            self._output.write(line + "\n")
            self._output.flush()
            if self._log_file is not None:
                try:
                    self._log_file.write(line + "\n")
                    self._log_file.flush()
                except Exception:
                    pass

    def log(self, message: str, level: str = "info") -> None:
        self.emit("agent_log", payload={
            "level": level,
            "message": message,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })

    def close(self) -> None:
        try:
            if self._log_file is not None:
                self._log_file.close()
        except Exception:
            pass

    def announce_supplement(self, text: str) -> None:
        """收到用户运行中的补充消息，确认并加入计划列表。"""
        with self._supplement_lock:
            self.supplements.append(text)
        self.log(f"用户补充消息：{text[:100]}", "info")
        self.emit("agent_message", payload={
            "content": f"接收到用户的补充：{text}。已加入计划列表，继续完成任务。",
            "kind": "progress",
        })

    def drain_supplements(self) -> list[str]:
        """取出并清空当前累积的用户补充消息（线程安全）。"""
        with self._supplement_lock:
            pending = list(self.supplements)
            self.supplements.clear()
            return pending


__all__ = [
    "WorkerRuntime",
    "WorkerRequestError",
    "PROTOCOL_VERSION",
]
