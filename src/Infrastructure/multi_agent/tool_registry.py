"""工具按职责分组注册表。

拆分 ALL_TOOLS 为 3 组：
- DECRYPT_ROLE: 只负责解密（4 平台 + 扫描 + 基础工具）
- TRANSCODE_ROLE: 只负责格式转换（ffmpeg）
- VERIFY_ROLE: 只负责完整性校验

设计原则:
1. 基础工具（scan/run_cli/list/sandbox/ask_user）各角色共享
2. 子 Agent 只暴露职责内工具 → 降低 prompt 成本 + 减少幻觉
3. 主 Agent 仍持有 ALL_TOOLS，负责规划/调度/文件管理

新增角色（未来扩展）:
- MANAGER_ROLE: 主 Agent 规划器（持有 ALL_TOOLS）
"""

from __future__ import annotations

import logging
from typing import Any

from src.Infrastructure.agent_tools import (
    ALL_TOOLS,
    decrypt_kugou,
    decrypt_qq,
    decrypt_netease,
    decrypt_kuwo,
    scan_files,
    run_cli_safely,
    list_directory,
    sandbox_manage,
    ask_user,
    transcode_audio,
    verify_audio_integrity,
    detect_format,
    copy_files,
    move_files,
    rename_file,
    rag_retrieve,
    rag_ingest,
)

logger = logging.getLogger("qkkdecrypt.infrastructure.multi_agent.tool_registry")

# 工具名 → 工具对象的快速查找表
_TOOL_BY_NAME: dict[str, Any] = {
    getattr(t, "name", t.__name__): t for t in ALL_TOOLS
}

# 基础工具：各角色共享
_BASE_TOOLS = [
    scan_files,
    run_cli_safely,
    list_directory,
    sandbox_manage,
    ask_user,
]

# 解密 Agent 工具集
DECRYPT_TOOLS: list = [
    scan_files,
    decrypt_kugou,
    decrypt_qq,
    decrypt_netease,
    decrypt_kuwo,
    run_cli_safely,
    list_directory,
    sandbox_manage,
    ask_user,
]

# 转换 Agent 工具集
TRANSCODE_TOOLS: list = [
    scan_files,
    transcode_audio,
    run_cli_safely,
    list_directory,
    sandbox_manage,
    ask_user,
]

# 验证 Agent 工具集
VERIFY_TOOLS: list = [
    scan_files,
    verify_audio_integrity,
    detect_format,
    copy_files,  # 验证可能需要移动损坏文件
    run_cli_safely,
    list_directory,
    sandbox_manage,
    ask_user,
]

# 主 Agent（规划器）工具集 = 全部
MANAGER_TOOLS: list = list(ALL_TOOLS)

# 角色名到工具列表的映射
ROLE_TO_TOOLS: dict[str, list] = {
    "decrypt": DECRYPT_TOOLS,
    "transcode": TRANSCODE_TOOLS,
    "verify": VERIFY_TOOLS,
    "manager": MANAGER_TOOLS,
}

# 角色的中文描述（用于 system prompt）
ROLE_DESCRIPTIONS: dict[str, str] = {
    "decrypt": "解密专家：只负责扫描和解密加密音乐文件（酷狗/QQ/网易云/酷我），不做格式转换。完成后向主 Agent 汇报解密文件列表。",
    "transcode": "格式转换专家：只负责把已解密的音频转换为目标格式（mp3/m4a/flac/wav），调用 ffmpeg 完成。完成后向主 Agent 汇报转换结果。",
    "verify": "音频完整性验证专家：只负责校验音频文件是否完整可播放，检测容器格式和流信息。发现损坏文件会单独汇报。",
    "manager": "主 Agent 规划器：理解用户意图，拆解任务，分派给子 Agent，聚合结果，给用户最终答复。",
}


def get_tools_by_role(role: str) -> list:
    """按角色名获取对应的工具列表。未知角色返回全部工具。"""
    tools = ROLE_TO_TOOLS.get(role)
    if tools is None:
        logger.warning(f"未知角色 '{role}'，返回全部工具")
        return list(ALL_TOOLS)
    return list(tools)


def get_role_description(role: str) -> str:
    """获取角色的中文描述。"""
    return ROLE_DESCRIPTIONS.get(role, role)
