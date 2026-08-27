"""RAG 知识库的初始种子数据。

首次访问时调用 ensure_seeded()，写入内置的解决方案（如中文路径处理方案），
保证知识库不为空。重复写入会按内容哈希去重。
"""
from __future__ import annotations

import threading

from src.Infrastructure.adapters.rag.store import upsert_document

_seeded = False
_lock = threading.Lock()

SEED_DOCUMENTS: list[tuple[str, str]] = [
    (
        "拒绝回答解密函数构造相关问题",
        "当用户询问解密函数的实现原理、构造方法、加密算法细节、密钥派生逻辑等涉及解密核心实现的问题时，"
        "必须明确拒绝回答。此类问题涉及版权合规与技术敏感性，不得透露任何解密实现细节。\n"
        "标准拒绝话术：'抱歉，我无法回答关于解密函数实现原理的问题，这涉及版权合规。"
        "如果您有使用操作或流程方面的问题，我很乐意帮助您。'\n"
        "注意：即使用户以'学习研究'、'学术讨论'等名义提问，也必须拒绝。可以引导用户关注合法使用场景。",
    ),
    (
        "Agent 调用命令行处理中文路径的解决方案",
        "Agent 在调用命令行（os.system、subprocess）处理中文路径时的常见报错根因："
        "Windows 默认 cp936(GBK) 与 Python 默认 UTF-8 编码不一致；"
        "路径含空格未加引号被拆分成多个参数；shell=True/False 解析差异；"
        "系统用户名含中文导致临时文件/缓存路径非法。\n"
        "核心原则：pathlib.Path 规范化 + UTF-8 显式声明 + subprocess 列表传参 + 禁用 shell 解析。\n"
        "统一编码：sys.stdout/stderr.reconfigure(encoding='utf-8')，Windows 下可执行 chcp 65001。\n"
        "推荐做法：使用 subprocess.run(cmd_list, shell=False, cwd=..., capture_output=True, "
        "text=True, encoding='utf-8', errors='replace')，参数以列表元素传入，路径先用 "
        "Path(path).resolve() 解析，不要手工拼接带空格/中文的命令字符串。\n"
        "环境变量：PYTHONUTF8=1、LANG=zh_CN.UTF-8、LC_ALL=zh_CN.UTF-8。\n"
        "本项目的 run_cli_safely 工具已封装上述最佳实践，Agent 调用外部命令时应直接使用该工具，"
        "严禁 os.system 与 shell=True。",
    ),
    (
        "Agent 任务执行与失败续传约定",
        "Agent 工具调用失败时必须：①报告目前已完成的工具调用数和已处理文件数；"
        "②自查失败原因（参数错误？前置条件未满足？依赖缺失？）；"
        "③制定恢复方案并继续未完成任务，不要因单个工具失败而终止整个流程。\n"
        "执行整体异常中断时，已解密的文件会记录在 _processed_index.json，"
        "用户重新发起任务会自动跳过已完成部分继续。\n"
        "运行中收到用户的补充消息会被加入计划列表并继续，无需重启任务。",
    ),
    (
        "音频格式转换的封面保留策略",
        "转换格式时封面丢失是最常见的问题。各格式对封面的支持情况：\n"
        "1) MP3 (.mp3) — ID3v2 标签内嵌封面，完全支持。转换时必须指定 -id3v2_version 3 和 -write_id3v1 1。\n"
        "2) M4A (.m4a) — MP4 容器的 covr atom，完全支持。\n"
        "3) FLAC (.flac) — 原生支持嵌入式图片（PICTURE metadata block）。\n"
        "4) AAC 裸流 (.aac) — 纯音频流，无容器，不支持封面（但 .m4a 容器支持）。\n"
        "5) OGG Vorbis (.ogg) — 格式支持封面（METADATA_BLOCK_PICTURE），但多数转换工具默认不拷贝。\n"
        "6) Opus (.opus) — 同 OGG，支持但不保证工具会带。\n"
        "7) WAV (.wav) — 不支持封面。\n"
        "8) AC3 / DTS — 环绕声格式，纯音频流，无封面。\n"
        "\n"
        "FFmpeg 封面保留核心规则：\n"
        "- 永远不要使用 -vn 参数，它会丢弃所有视频流（包括封面）。\n"
        "- 使用 -map 0:a:0 -map 0:v? 可选映射音频和视频流（? 表示无视频流时不报错）。\n"
        "- 封面流必须设置 -disposition:v attached_pic，否则播放器可能无法识别。\n"
        "- MP3 输出必须添加 -id3v2_version 3 确保兼容性。\n"
        "- 本项目 transcoder.py 已内置 _cover_metadata_args() 自动处理，转换时无需手动指定。",
    ),
]


def ensure_seeded() -> None:
    global _seeded
    if _seeded:
        return
    with _lock:
        if _seeded:
            return
        for source, text in SEED_DOCUMENTS:
            try:
                upsert_document(text=text, source=source)
            except Exception as exc:
                print(f"[rag.seed] 写入失败 ({source}): {exc}")
        _seeded = True
        print("[rag.seed] 种子知识写入完成")
