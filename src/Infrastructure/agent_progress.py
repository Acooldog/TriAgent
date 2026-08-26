from __future__ import annotations

import time
from typing import Any, Callable

SYSTEM_PROMPT = """你是 TriMusicAgent，一个专业的音乐处理助手。你需要像一个能干的助手一样与用户交流。

你的能力包括：
1. 扫描和识别加密音乐文件（酷狗 kgma/kgm/kgg/vpr 格式）
2. 使用 UnlockMusic 完整算法解密酷狗音乐文件
3. 管理文件（复制、移动）
4. 检测音频格式

## 交流规则
- 必须使用中文。
- 收到任务后先简要说明准备怎么做，不展示隐含推理。
- 调用工具前说明下一步行动，工具完成后报告结果。
- 遇到问题时说明现状和恢复方向，完成时给出结果摘要。
- 每次只调用一个工具，等待结果后再决定下一步。"""

TOOL_ACTION_MESSAGES = {
    "scan_files": "我先扫描目标目录，确认有哪些可处理的音乐文件。",
    "decrypt_kugou": "文件范围已经确认，我现在开始解密，并会记录成功和失败结果。",
    "move_files": "文件已经处理好，我接下来把它们整理到目标目录。",
    "detect_format": "我先检测文件的实际音频格式，再决定后续处理方式。",
    "list_directory": "我先查看目标目录的内容，确认路径和文件是否符合预期。",
}


class AgentEventEmitter:
    def __init__(self, event_sink: Callable[[str, dict[str, Any]], None]) -> None:
        self._sink = event_sink

    def _log(self, message: str, level: str = "info") -> None:
        try:
            self._sink("agent_log", {
                "level": level,
                "message": message,
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime()),
            })
        except Exception:
            pass

    def emit(self, event_type: str, payload: dict[str, Any] | None = None) -> None:
        self._log(f"发射事件: {event_type}", "debug")
        try:
            self._sink(event_type, payload or {})
        except Exception as exc:
            self._log(f"事件发射失败: {event_type} - {exc}", "error")


def build_initial_action_message(user_message: str) -> str:
    normalized = user_message.lower()
    if any(token in normalized for token in ("解密", "kgma", "kgm", "kgg", "vpr")):
        return "我先核对输入和输出路径，再扫描目标目录里的可处理文件；确认格式后开始解密，并在完成后汇总结果。"
    if any(token in normalized for token in ("扫描", "查找", "列出", "目录")):
        return "我先检查目标目录和文件范围，再根据扫描结果决定下一步操作。"
    return "我先梳理你的目标和限制，再检查可用工具；确认执行路径后逐步处理，并持续汇报进展。"


def build_tool_action_message(tool_name: str) -> str:
    return TOOL_ACTION_MESSAGES.get(tool_name, f"我准备调用 {tool_name} 继续处理，并会在完成后报告结果。")


def build_system_prompt(tool_names: list[str], tool_descriptions: dict[str, str]) -> str:
    descriptions = "\n".join(f"- {name}: {tool_descriptions.get(name, '')}" for name in tool_names)
    return f"{SYSTEM_PROMPT}\n\n可用工具：\n{descriptions}"
