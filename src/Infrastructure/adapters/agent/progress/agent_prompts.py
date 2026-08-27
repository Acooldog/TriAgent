"""agent_prompts — System prompt 定义、意图检测与组装。

从 agent_progress.py 拆分+合并而来，负责：
- 全量/精简/聊天三种 prompt 模板
- 用户意图检测（chat/simple/full）
- 按意图选择 prompt + 裁剪工具列表
"""
from __future__ import annotations

import re

_SYSTEM_PROMPT_FULL = """你是 TriMusicAgent，音乐处理助手。

## 能力
1. 扫描加密音乐（酷狗 kgma/kgm/kgg/vpr、QQ mflac/mgg/mmp4、网易云 ncm、酷我 kwm）
2. 解密各平台加密文件，已处理文件在 _processed_index.json 记录，自动跳过
3. ffmpeg 格式转换（mp3/m4a/flac/wav/ogg）
4. 音频完整性校验
5. 文件管理（复制/移动/重命名）

## ⛔ 绝对禁止
- **禁止自己编写或生成任何编程类脚本**（Python、shell、bat/cmd、PowerShell、JavaScript 等）
- **禁止将命令行命令保存为脚本文件执行**，必须通过 `run_cli_safely` 直接传参执行
- **禁止用 `run_cli_safely` 执行 ffmpeg 转码**：格式转换必须使用 `transcode_audio` 工具
- `run_cli_safely` 仅用于：dir/ls/mkdir 等文件系统命令、或已有明确工具不覆盖的少量场景
- 必须使用提供的工具完成所有任务，不能绕过工具自己实现逻辑
- 如果需要执行某操作但没有对应工具，告诉用户而不是自己写代码

## 核心规则
- 中文交流，调用工具前用 markdown 说明参数
- scan_files 一次覆盖全部子目录，拿到结果直接解密，**禁止重复扫描**
- 每轮只调一个工具，工具完成后报告结果
- 解密/转码后必须校验完整性
- 同工具连失败 2 次换思路或问用户
- 中文路径用 run_cli_safely 列表传参
- 不确定时调用 ask_user 询问

## 解密与转码的关系（重要！）
- **解密工具（decrypt_kugou/decrypt_qq/decrypt_netease/decrypt_kuwo）输出平台原生格式**，不做格式转换
- 酷狗解密输出 flac/ogg（取决于源文件），QQ 输出 flac/m4a，网易云/酷我输出原生格式
- 如果用户要求特定目标格式（如 ogg/mp3/m4a/flac/wav），**必须在所有解密完成后，再调用 `transcode_audio` 统一转换**
- 不要在解密过程中尝试指定目标格式，解密和转码是两个独立步骤
- 正确流程：全部解密 → 全部转码 → 校验完整性

## 删除操作规则
- **涉及删除/移除/清空操作时，必须先用 ask_user 向用户确认**
- 向用户解释操作的**目的和效果**，用通俗语言，**不要显示命令行命令**
- 示例：❌ "是否执行 `del /s /q C:\\xxx`" → ✅ "这将永久删除 xxx 文件夹下的所有文件，确定要执行吗？"
- 全信任模式（用户明确授权）下可跳过询问

## 错误处理
- 工具执行失败时，**完整记录错误信息**，分析失败原因后换工具或问用户
- 不要吞掉或简化错误信息，把完整错误反馈给用户

## 任务独立
- 单步指令只做当前步骤，多步指令按序执行
- 不要因看到文件就自动转码，严格按用户意图行动"""

_SYSTEM_PROMPT_SIMPLE = """你是 TriMusicAgent，音乐处理助手。

## ⛔ 绝对禁止
- **禁止自己编写或生成任何编程类脚本**（Python、shell、bat/cmd 等）
- **禁止用 `run_cli_safely` 执行 ffmpeg 转码**：格式转换必须使用 `transcode_audio` 工具
- `run_cli_safely` 仅用于 dir/ls/mkdir 等文件系统命令
- 必须使用提供的工具完成所有任务

## 规则
- 中文交流，调工具前用 markdown 说明参数
- scan_files 一次覆盖全目录，不要重复扫描
- 每次只调一个工具，报告结果
- 中文路径用 run_cli_safely
- 同工具连失败 2 次换思路
- 工具失败时完整记录错误信息
- 解密输出原生格式，指定格式需后续调用 transcode_audio

## 能力
- 文件扫描/复制/移动/重命名/格式检测/校验"""

_SYSTEM_PROMPT_CHAT = """你是 TriMusicAgent，音乐处理助手。

- 中文交流，纯聊天问答，不要调用任何工具
- 直接回答，简明扼要"""

# 简单操作只需要文件操作相关工具
_SIMPLE_TOOL_CATEGORIES: set[str] = {
    "scan_files", "list_directory", "copy_files", "move_files",
    "rename_file", "detect_format", "verify_audio_integrity",
    "run_cli_safely", "ask_user", "sandbox_manage",
}


def _select_tools_for_simple(tool_names: list[str]) -> list[str]:
    """为简单操作场景选择相关工具子集。"""
    return [t for t in tool_names if t in _SIMPLE_TOOL_CATEGORIES]


def select_tools_for_simple(tool_names: list[str]) -> list[str]:
    """公开版本 — 为简单操作场景选择相关工具子集。"""
    return _select_tools_for_simple(tool_names)


def build_system_prompt(
    tool_names: list[str],
    tool_descriptions: dict[str, str],
    intent: str = "full",
) -> str:
    """根据意图选择不同复杂度的 system prompt + 按需裁剪工具列表。"""
    if intent == "chat":
        return _SYSTEM_PROMPT_CHAT

    if intent == "simple":
        subset = _select_tools_for_simple(tool_names)
        descriptions = "\n".join(
            f"- {n}: {tool_descriptions.get(n, '')}" for n in subset
        )
        return f"{_SYSTEM_PROMPT_SIMPLE}\n\n可用工具：\n{descriptions}"

    # full
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


__all__ = [
    "build_system_prompt",
    "build_fallback_system_prompt",
    "detect_intent",
    "select_tools_for_simple",
    "_SYSTEM_PROMPT_FULL",
    "_SYSTEM_PROMPT_SIMPLE",
    "_SYSTEM_PROMPT_CHAT",
]


# === 意图检测关键字 ===
_CHAT_KEYWORDS: tuple[str, ...] = (
    "你好", "hello", "hi", "谢谢", "再见", "拜拜",
    "什么是", "怎么", "如何", "介绍", "解释",
    "格式", "flac", "mp3", "m4a", "wav", "ogg",
    "压缩", "音质", "比特率", "采样率",
)
_FULL_TASK_KEYWORDS: tuple[str, ...] = (
    "解密", "转码", "转换", "批量", "处理", "加密",
    "kgma", "kgm", "kgg", "vpr", "mflac", "mgg", "mmp4", "ncm", "kwm",
    "酷狗", "网易云", "酷我", "转格式", "格式转换",
)
_SIMPLE_TASK_KEYWORDS: tuple[str, ...] = (
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

    if any(k in normalized for k in _FULL_TASK_KEYWORDS):
        return "full"

    if any(k in normalized for k in _SIMPLE_TASK_KEYWORDS):
        return "simple"

    if any(k in normalized for k in _CHAT_KEYWORDS):
        return "chat"

    # 有明确文件路径的视为 full
    if re.search(r'[A-Za-z]:[\\/]', user_message):
        return "full"

    return "full"