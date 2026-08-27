"""Agent safety — 删除/破坏性操作检测。

从 agent_tools_file_ops.py 拆出，保持单文件 ≤300 行。
"""
from __future__ import annotations

import pathlib

# 删除/破坏性命令模式
_DESTRUCTIVE_PATTERNS: dict[str, str] = {
    "del": "删除文件",
    "rmdir": "删除目录",
    "rd": "删除目录",
    "rm": "删除/移除",
    "remove": "移除",
    "clear": "清空",
    "erase": "擦除",
    "format": "格式化",
    "diskpart": "磁盘操作",
    "shutil.rmtree": "递归删除",
    "shutil.rm": "删除",
}


def detect_destructive_intent(cmd_list: list[str]) -> str | None:
    """检测命令列表中的删除/破坏性意图，返回操作类型描述。无危险则返回 None。"""
    if not cmd_list:
        return None
    full_cmd = " ".join(str(c).lower() for c in cmd_list)
    cmd_basename = pathlib.Path(cmd_list[0]).name.lower()
    # 1. 直接删除类命令
    if cmd_basename in _DESTRUCTIVE_PATTERNS:
        return _DESTRUCTIVE_PATTERNS[cmd_basename]
    # 2. cmd /c 包裹的删除命令
    if cmd_basename == "cmd":
        for pattern, desc in _DESTRUCTIVE_PATTERNS.items():
            if pattern in full_cmd:
                return f"cmd 执行: {desc}"
    # 3. python -c 中的删除操作
    if cmd_basename in ("python", "python.exe", "python3", "py"):
        if any(p in full_cmd for p in (
            "shutil.rmtree", "os.remove", "os.unlink", "os.rmdir",
            "pathlib.unlink", "shutil.rm",
        )):
            return "Python 脚本删除操作"
    # 4. PowerShell 删除
    if cmd_basename in ("powershell", "powershell.exe", "pwsh"):
        if any(p in full_cmd for p in ("remove-item", "rm-item", "del ", "rd ")):
            return "PowerShell 删除操作"
    return None


__all__ = [
    "detect_destructive_intent",
    "_DESTRUCTIVE_PATTERNS",
]