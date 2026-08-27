from __future__ import annotations

from src.Infrastructure.adapters.agent.tools.agent_tools_decrypt import (
    decrypt_kugou,
    decrypt_kuwo,
    decrypt_netease,
    decrypt_qq,
    scan_files,
)
from src.Infrastructure.adapters.agent.tools.agent_tools_file_ops import (
    ask_user,
    copy_files,
    detect_format,
    list_directory,
    move_files,
    rename_file,
    run_cli_safely,
    sandbox_manage,
)
from src.Infrastructure.adapters.agent.tools.agent_tools_media import (
    rag_ingest,
    rag_retrieve,
    transcode_audio,
    verify_audio_integrity,
)
from src.Infrastructure.adapters.agent.tools.agent_tools_state import (
    _CliArgs,
    _safe_tool_name,
    set_ask_user_callback,
    set_permission_mode,
)


TOOL_DESCRIPTIONS = {
    "scan_files": "扫描目录下加密音乐文件（kgma/kgm/kgg/vpr/mflac/mgg/mmp4/ncm/kwm），返回按格式分组列表。扫描后直接解密，不要重复扫描。",
    "decrypt_kugou": "解密酷狗加密文件（kgma/kgm/kgg/vpr），输出可播放音频。传目录可批量处理。",
    "decrypt_qq": "解密 QQ 音乐加密文件（mflac/mgg/mmp4），需 QQ 客户端运行。传目录可批量处理。",
    "decrypt_netease": "解密网易云加密文件（ncm），无需客户端。传目录可批量处理。",
    "decrypt_kuwo": "解密酷我加密文件（kwm），无需客户端。传目录可批量处理。",
    "transcode_audio": "【首选】音频格式转换工具（mp3/m4a/flac/wav/ogg），支持单文件和目录批量。必须用此工具，禁止用 run_cli_safely 调用 ffmpeg 做转码。",
    "verify_audio_integrity": "校验音频文件完整性，判断是否损坏。解密/转码后必须调用。",
    "copy_files": "复制文件到目标目录，支持按扩展名过滤。",
    "move_files": "移动文件到目标目录，支持按扩展名过滤。",
    "rename_file": "重命名单个文件。",
    "run_cli_safely": "安全执行命令行程序（仅用于 dir/ls/mkdir 等文件命令）。**禁止用 ffmpeg 调用**——格式转换必须用 transcode_audio 工具。",
    "rag_retrieve": "检索知识库中的相关经验。",
    "rag_ingest": "写入经验到知识库。",
    "detect_format": "检测音频文件容器格式。",
    "list_directory": "列出目录内容，仅用于确认路径。不要重复 scan_files 结果。",
    "ask_user": "遇到不确定时询问用户选择。",
    "sandbox_manage": "管理文件操作沙箱授权。通常无需调用。",
}


ALL_TOOLS = [
    scan_files,
    decrypt_kugou,
    decrypt_qq,
    decrypt_netease,
    decrypt_kuwo,
    copy_files,
    move_files,
    rename_file,
    run_cli_safely,
    transcode_audio,
    verify_audio_integrity,
    detect_format,
    rag_retrieve,
    rag_ingest,
    list_directory,
    ask_user,
    sandbox_manage,
]
TOOL_NAMES = [_safe_tool_name(t) for t in ALL_TOOLS]


__all__ = [
    "TOOL_DESCRIPTIONS",
    "ALL_TOOLS",
    "TOOL_NAMES",
    "set_ask_user_callback",
    "set_permission_mode",
    "_CliArgs",
    # re-exported tools for direct import convenience
    "scan_files",
    "decrypt_kugou",
    "decrypt_qq",
    "decrypt_netease",
    "decrypt_kuwo",
    "copy_files",
    "move_files",
    "rename_file",
    "run_cli_safely",
    "transcode_audio",
    "verify_audio_integrity",
    "detect_format",
    "rag_retrieve",
    "rag_ingest",
    "list_directory",
    "ask_user",
    "sandbox_manage",
]
