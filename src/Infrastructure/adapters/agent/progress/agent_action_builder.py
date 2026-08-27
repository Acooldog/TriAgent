"""agent_action_builder — 工具行动消息构建。

从 agent_progress.py 拆分而来，负责为每个工具调用生成说明文本。
"""
from __future__ import annotations

import json

TOOL_ACTION_MESSAGES: dict[str, str] = {
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


def build_initial_action_message(user_message: str) -> str:
    """根据用户消息生成初始行动描述。"""
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

    try:
        args_dict: dict[str, object] = json.loads(tool_args) if isinstance(tool_args, str) else tool_args
        if isinstance(args_dict, dict):
            key_parts: list[str] = []
            for k, v in args_dict.items():
                v_str = str(v)
                if len(v_str) > 80:
                    v_str = v_str[:77] + "..."
                key_parts.append(f"`{k}`={v_str}")
            if key_parts:
                return f"{base_msg}\n\n> 参数: {', '.join(key_parts)}"
    except (json.JSONDecodeError, TypeError):
        pass

    args_preview = tool_args[:100] if len(tool_args) > 100 else tool_args
    return f"{base_msg}\n\n> 参数: `{args_preview}`"


__all__ = [
    "TOOL_ACTION_MESSAGES",
    "build_initial_action_message",
    "build_tool_action_message",
]