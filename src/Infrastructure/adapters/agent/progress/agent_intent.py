"""agent_intent — 用户意图检测。

从 agent_progress.py 拆分而来，负责将用户消息分类为 chat/simple/full。
"""
from __future__ import annotations

import re

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


__all__ = ["detect_intent"]