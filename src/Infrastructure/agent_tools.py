from __future__ import annotations

from src.Infrastructure.agent_tools_decrypt import (
    decrypt_kugou,
    decrypt_kuwo,
    decrypt_netease,
    decrypt_qq,
    scan_files,
)
from src.Infrastructure.agent_tools_file_ops import (
    ask_user,
    copy_files,
    detect_format,
    list_directory,
    move_files,
    rename_file,
    run_cli_safely,
    sandbox_manage,
)
from src.Infrastructure.agent_tools_media import (
    rag_ingest,
    rag_retrieve,
    transcode_audio,
    verify_audio_integrity,
)
from src.Infrastructure.agent_tools_state import (
    _CliArgs,
    _safe_tool_name,
    set_ask_user_callback,
    set_permission_mode,
)


TOOL_DESCRIPTIONS = {
    "scan_files": "扫描指定目录下的加密音乐文件（支持 kgma/kgm/kgg/vpr/mflac/mgg/mmp4/ncm/kwm 格式），返回找到的文件列表和数量。",
    "decrypt_kugou": "解密酷狗音乐加密文件（kgma、kgm、kgg、vpr 等格式），输出为可播放的音频文件。",
    "decrypt_qq": "解密 QQ 音乐加密文件（mflac、mgg、mmp4 格式），输出为可播放的音频文件。需要 QQ 音乐客户端已运行。",
    "decrypt_netease": "解密网易云音乐加密文件（ncm 格式），输出为可播放的音频文件。无需运行网易云音乐客户端。",
    "decrypt_kuwo": "解密酷我音乐加密文件（kwm 格式），输出为可播放的音频文件。无需运行酷我音乐客户端。",
    "transcode_audio": "调用 ffmpeg 将音频文件转换为目标格式（mp3/m4a/flac/wav）。支持单文件或目录批量处理。",
    "verify_audio_integrity": "校验音频文件是否完整可播放，通过容器探测和流信息分析判断文件是否损坏。解密或格式转换后必须调用本工具确认结果。",
    "copy_files": "将文件从源路径复制到目标目录（保留源文件），保持文件名不变。支持批量操作。",
    "move_files": "将文件从源目录移动到目标目录（不保留源文件），支持按扩展名过滤。适用于整理文件结构，如把flac/ogg移到子目录。",
    "rename_file": "重命名单个文件，保持在原目录不变。目标名已存在时报错以防止覆盖。",
    "run_cli_safely": "安全执行命令行程序，统一处理中文路径与编码（subprocess 列表传参 + UTF-8）。凡需调用外部命令必须用本工具，禁止 os.system 或 shell=True。",
    "rag_retrieve": "在本地知识库中检索与问题相关的已沉淀解决方案/经验（如中文路径处理、失败续传约定）。遇到不确定如何处理的问题时先检索知识库。",
    "rag_ingest": "把一条经验/解决方案写入本地知识库，便于后续检索复用。仅在完成了一条值得沉淀的通用经验时调用。",
    "detect_format": "检测音频文件的容器格式（flac/mp3/m4a/wav/ogg 等），通过读取文件头特征判断。",
    "list_directory": "列出指定目录下的所有文件和子目录，返回文件名称列表。",
    "ask_user": "遇到不确定的操作时询问用户。给出清晰的问题和 2~4 个互斥选项，用户选择后返回所选内容。常用于：处理记录与实际输出不一致、目标文件已存在等无法判断用户意图的场景。",
    "sandbox_manage": "管理文件操作沙箱：授权/取消授权目录、查看当前授权目录。所有文件操作必须在授权目录范围内。",
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
