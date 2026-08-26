"""RAG 知识库的初始种子数据。

首次访问时调用 ensure_seeded()，写入内置的解决方案（如中文路径处理方案），
保证知识库不为空。重复写入会按内容哈希去重。
"""
from __future__ import annotations

import threading

from src.Infrastructure.rag.store import upsert_document

_seeded = False
_lock = threading.Lock()

SEED_DOCUMENTS: list[tuple[str, str]] = [
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
