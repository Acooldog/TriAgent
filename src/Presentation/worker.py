from __future__ import annotations

import contextlib
import json
import pathlib
import sys
import threading
import time
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
    runtime.emit("worker_started", payload={"operation": request["operation"], "log_path": runtime._log_path})
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
    try:
        from src.Infrastructure.agent_tools import set_ask_user_callback
        set_ask_user_callback(runtime.ask_user)
        runtime.log("已注入 ask_user 回调")
    except Exception as exc:
        runtime.log(f"ask_user 回调注入失败：{exc}", "warning")
    threading.Thread(target=read_control, args=(runtime,), daemon=True).start()

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
                consume_supplements=runtime.drain_supplements,
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


def read_control(runtime: WorkerRuntime) -> None:
    """监听 stdin，处理 cancel（取消）、supplement（运行中补充）与 user_answer（询问回答）。"""
    for line in sys.stdin:
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(value, dict):
            continue
        if value.get("request_id") != runtime.request_id or value.get("task_id") != runtime.task_id:
            continue
        command = value.get("command")
        if command == "cancel":
            runtime.cancelled.set()
            return
        if command == "supplement":
            text = str(value.get("text", "") or "").strip()
            if text:
                runtime.announce_supplement(text)
        elif command == "user_answer":
            question_id = str(value.get("question_id", "") or "").strip()
            answer = str(value.get("answer", "") or "").strip()
            if question_id and answer:
                runtime.provide_answer(question_id, answer)


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
        threading.Thread(target=read_control, args=(runtime,), daemon=True).start()
    try:
        return run_request(request, runtime)
    finally:
        runtime.close()


if __name__ == "__main__":
    raise SystemExit(main())
