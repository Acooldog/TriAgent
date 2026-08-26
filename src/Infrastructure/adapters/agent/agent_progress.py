from __future__ import annotations

import time
from typing import Any, Callable

SYSTEM_PROMPT = """你是 TriMusicAgent，一个专业的音乐处理助手。你需要像一个能干的助手一样与用户交流。

你的能力包括：
1. 扫描和识别加密音乐文件（酷狗 kgma/kgm/kgg/vpr、QQ mflac/mgg/mmp4、网易云 ncm、酷我 kwm 等格式）
2. 解密酷狗、QQ、网易云、酷我音乐文件，输出为可播放的音频文件。已解密的加密文件会在其所在目录的 _processed_index.json 中记录，再次解密前自动复查并跳过已处理文件
3. 调用 ffmpeg 将解密后的音频转换为目标格式（mp3/m4a/flac/wav）
4. 校验解密或转码后的音频文件是否完整可播放，损坏文件必须重新处理
5. 管理文件（复制、移动、重命名、删除）
6. 检测音频格式

## 任务独立性（最高优先级）
- 每个用户指令是独立的任务，之前的任务上下文只用于参考，不得覆盖当前指令。
- 用户说"移动flac到backup"就是移动，不要因为看到flac文件就自动转码。
- 用户说"只保留mp3"就是筛选/移动操作，不要把它理解为"把所有文件转成mp3"。
- 只有当用户明确要求"解密"或"转换格式"时才执行解密/转码流程。
- 多步指令（如"先解密再转mp3"）按顺序执行，单步指令只做当前步骤。

## 交流规则
- 必须使用中文。
- **先判断用户意图**：用户的消息分为两种——①纯聊天/问答（如"你好"、"这个格式怎么读"、"什么是flac"），这类直接用自然语言回答，不调用任何工具；②任务请求（如"帮我转格式"、"扫描这个目录"、"解密文件"），这类才调用工具执行。
- 收到任务后先简要说明准备怎么做，不展示隐含推理。
- 调用工具前必须用 markdown 格式说明具体操作，包括工具名和关键参数。例如：`正在移动文件: move_files(source_dir="D:/音乐", target_dir="D:/音乐/backup", file_extensions=".flac,.ogg")`。不要用泛泛的"我现在调用命令行程序处理"。
- 工具完成后用 markdown 报告结果，包括处理了多少文件、成功/失败数量。
- 解密或格式转换完成后必须调用 verify_audio_integrity 校验文件完整性；损坏的文件必须重新解密或转码。
- 工具调用失败时必须：①报告目前已完成的工具调用数和已处理文件数；②自查失败原因；③制定恢复方案并继续未完成任务。
- 工具重试约束：同一工具用同一思路连续失败 2 次后，禁止再用同样方式重试第 3 次，必须换思路或询问用户。
- 遇到不确定的操作必须先调用 ask_user 工具询问用户，由用户选择后再继续。
- 命令行与中文路径处理：使用 run_cli_safely 工具，列表传参，路径先规范化。
- 完成时给出结果摘要。
- 每次只调用一个工具，等待结果后再决定下一步。"""

TOOL_ACTION_MESSAGES = {
    "scan_files": "我先扫描目标目录，确认有哪些可处理的音乐文件。",
    "decrypt_kugou": "文件范围已经确认，我现在开始解密，并会记录成功和失败结果。",
    "decrypt_qq": "文件范围已经确认，我现在开始解密，并会记录成功和失败结果。",
    "decrypt_netease": "文件范围已经确认，我现在开始解密，并会记录成功和失败结果。",
    "decrypt_kuwo": "文件范围已经确认，我现在开始解密，并会记录成功和失败结果。",
    "transcode_audio": "解密已完成，我现在调用 ffmpeg 转换为目标格式。",
    "verify_audio_integrity": "转换已完成，我现在校验文件完整性，确认无损坏。",
    "copy_files": "文件已经处理好，我接下来把它们复制到目标目录。",
    "move_files": "我现在把文件移动到目标目录。",
    "rename_file": "我现在重命名这个文件，便于整理。",
    "run_cli_safely": "我现在调用命令行程序处理，使用安全的列表传参方式避免中文路径问题。",
    "detect_format": "我先检测文件的实际音频格式，再决定后续处理方式。",
    "list_directory": "我先查看目标目录的内容，确认路径和文件是否符合预期。",
    "ask_user": "遇到不确定的情况，我先询问用户如何处理。",
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
    if any(token in normalized for token in ("解密", "kgma", "kgm", "kgg", "vpr", "mflac", "mgg", "mmp4", "ncm", "kwm", "qq", "网易云", "酷我")):
        return "我先核对输入和输出路径，再扫描目标目录里的可处理文件；确认格式后开始解密，并在完成后汇总结果。"
    if any(token in normalized for token in ("扫描", "查找", "列出", "目录")):
        return "我先检查目标目录和文件范围，再根据扫描结果决定下一步操作。"
    return "我先梳理你的目标和限制，再检查可用工具；确认执行路径后逐步处理，并持续汇报进展。"


def build_tool_action_message(tool_name: str, tool_args: str = "") -> str:
    """生成具体的工具调用说明，包含参数详情，用 markdown 格式。"""
    base_msg = TOOL_ACTION_MESSAGES.get(tool_name, f"调用 `{tool_name}` 继续处理。")
    if not tool_args:
        return base_msg

    # 尝试解析 JSON 参数，提取关键字段
    try:
        import json
        args_dict = json.loads(tool_args) if isinstance(tool_args, str) else tool_args
        if isinstance(args_dict, dict):
            key_parts = []
            for k, v in args_dict.items():
                v_str = str(v)
                if len(v_str) > 80:
                    v_str = v_str[:77] + "..."
                key_parts.append(f"`{k}`={v_str}")
            if key_parts:
                return f"{base_msg}\n\n> 参数: {', '.join(key_parts)}"
    except (json.JSONDecodeError, TypeError):
        pass

    # 非 JSON 格式，直接截取
    args_preview = tool_args[:100] if len(tool_args) > 100 else tool_args
    return f"{base_msg}\n\n> 参数: `{args_preview}`"


def build_system_prompt(tool_names: list[str], tool_descriptions: dict[str, str]) -> str:
    descriptions = "\n".join(f"- {name}: {tool_descriptions.get(name, '')}" for name in tool_names)
    return f"{SYSTEM_PROMPT}\n\n可用工具：\n{descriptions}"
