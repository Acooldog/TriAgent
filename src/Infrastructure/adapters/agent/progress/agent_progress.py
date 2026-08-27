from __future__ import annotations

import time
from typing import Any, Callable

# === 精简版 System Prompt ===
_SYSTEM_PROMPT_FULL = """你是 TriMusicAgent，音乐处理助手。

## 能力
1. 扫描加密音乐（酷狗 kgma/kgm/kgg/vpr、QQ mflac/mgg/mmp4、网易云 ncm、酷我 kwm）
2. 解密各平台加密文件，已处理文件在 _processed_index.json 记录，自动跳过
3. ffmpeg 格式转换（mp3/m4a/flac/wav）
4. 音频完整性校验
5. 文件管理（复制/移动/重命名）

## 核心规则
- 中文交流，调用工具前用 markdown 说明参数
- scan_files 一次覆盖全部子目录，拿到结果直接解密，**禁止重复扫描**
- 每轮只调一个工具，工具完成后报告结果
- 解密/转码后必须校验完整性
- 同工具连失败 2 次换思路或问用户
- 中文路径用 run_cli_safely 列表传参
- 不确定时调用 ask_user 询问

## 任务独立
- 单步指令只做当前步骤，多步指令按序执行
- 不要因看到文件就自动转码，严格按用户意图行动"""

_SYSTEM_PROMPT_SIMPLE = """你是 TriMusicAgent，音乐处理助手。

## 规则
- 中文交流，调工具前用 markdown 说明参数
- scan_files 一次覆盖全目录，不要重复扫描
- 每次只调一个工具，报告结果
- 中文路径用 run_cli_safely
- 同工具连失败 2 次换思路

## 能力
- 文件扫描/复制/移动/重命名/格式检测/校验"""

_SYSTEM_PROMPT_CHAT = """你是 TriMusicAgent，音乐处理助手。

- 中文交流，纯聊天问答，不要调用任何工具
- 直接回答，简明扼要"""

# 意图检测：返回 'chat' / 'simple' / 'full'
_CHAT_KEYWORDS = (
    "你好", "hello", "hi", "谢谢", "再见", "拜拜",
    "什么是", "怎么", "如何", "介绍", "解释",
    "格式", "flac", "mp3", "m4a", "wav", "ogg",
    "压缩", "音质", "比特率", "采样率",
)
_FULL_TASK_KEYWORDS = (
    "解密", "转码", "转换", "批量", "处理", "加密",
    "kgma", "kgm", "kgg", "vpr", "mflac", "mgg", "mmp4", "ncm", "kwm",
    "酷狗", "网易云", "酷我", "转格式", "格式转换",
)
_SIMPLE_TASK_KEYWORDS = (
    "移动", "复制", "重命名", "删除", "整理", "筛选",
    "扫描", "查找", "列出", "检测", "列出目录",
    "校验", "验证", "完整性",
)


def detect_intent(user_message: str) -> str:
    """检测用户意图：chat（纯聊天）/ simple（单步操作）/ full（完整任务）。

    优先级：full > simple > chat，确保不会误判为轻量模式。
    """
    normalized = user_message.lower().strip()
    if not normalized:
        return "full"

    # 完整任务关键词优先
    if any(k in normalized for k in _FULL_TASK_KEYWORDS):
        return "full"

    # 单步操作关键词
    if any(k in normalized for k in _SIMPLE_TASK_KEYWORDS):
        return "simple"

    # 聊天关键词
    if any(k in normalized for k in _CHAT_KEYWORDS):
        return "chat"

    # 有明确文件路径的视为 full
    import re
    if re.search(r'[A-Za-z]:[\\/]', user_message):
        return "full"

    # 不确定 → full（安全兜底）
    return "full"

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


def build_system_prompt(
    tool_names: list[str],
    tool_descriptions: dict[str, str],
    intent: str = "full",
) -> str:
    """根据意图选择不同复杂度的 system prompt + 按需裁剪工具列表。

    Args:
        tool_names: 可用工具名列表（全量）
        tool_descriptions: 工具描述字典
        intent: 'chat' / 'simple' / 'full'

    Returns:
        组装好的 system prompt 字符串
    """
    # 按意图选择 prompt 模板和工具子集
    if intent == "chat":
        # 纯聊天：不传工具，节省大量 token
        return _SYSTEM_PROMPT_CHAT

    if intent == "simple":
        # 简单操作：只传文件操作相关工具
        subset = _select_tools_for_simple(tool_names)
        descriptions = "\n".join(
            f"- {n}: {tool_descriptions.get(n, '')}" for n in subset
        )
        return f"{_SYSTEM_PROMPT_SIMPLE}\n\n可用工具：\n{descriptions}"

    # full：完整 prompt + 完整工具列表
    descriptions = "\n".join(
        f"- {n}: {tool_descriptions.get(n, '')}" for n in tool_names
    )
    return f"{_SYSTEM_PROMPT_FULL}\n\n可用工具：\n{descriptions}"


def build_fallback_system_prompt(tool_names: list[str], tool_descriptions: dict[str, str]) -> str:
    """当轻量模式下模型返回工具调用时，构建全量 fallback prompt。"""
    descriptions = "\n".join(
        f"- {n}: {tool_descriptions.get(n, '')}" for n in tool_names
    )
    return f"{_SYSTEM_PROMPT_FULL}\n\n可用工具：\n{descriptions}"


# === 工具子集选择 ===
# 简单操作只需要文件操作相关工具，不需要解密/转码/rag 工具
_SIMPLE_TOOL_CATEGORIES = {
    "scan_files", "list_directory", "copy_files", "move_files",
    "rename_file", "detect_format", "verify_audio_integrity",
    "run_cli_safely", "ask_user", "sandbox_manage",
}


def _select_tools_for_simple(tool_names: list[str]) -> list[str]:
    """为简单操作场景选择相关工具子集。"""
    return [t for t in tool_names if t in _SIMPLE_TOOL_CATEGORIES]
