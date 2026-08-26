"""QQ 音乐自动启动工具。

职责：
1. 通过 Windows 注册表查找 QQMusic.exe 安装路径
2. subprocess.Popen 列表传参启动
3. 轮询等待进程出现 + DLL 加载完成（Frida attach 需要）
4. 全程关键日志，失败时降级返回（不抛异常）

硬约束：subprocess 必须列表传参，shell=False，encoding='utf-8'
"""

from __future__ import annotations

import logging
import os
import pathlib
import subprocess
import sys
import time
from typing import Optional

from src.Infrastructure.process_utils import find_process_by_name

logger = logging.getLogger("qkkdecrypt.infrastructure.platforms.qq.launcher")


# 注册表候选路径（按优先级排序）
_REGISTRY_SEARCH_KEYS = [
    # 用户级安装
    ("HKCU", r"Software\Tencent\QQMusic"),
    ("HKCU", r"Software\WOW6432Node\Tencent\QQMusic"),
    # 系统级安装
    ("HKLM", r"Software\Tencent\QQMusic"),
    ("HKLM", r"Software\WOW6432Node\Tencent\QQMusic"),
    # 通用卸载表
    ("HKLM", r"Software\Microsoft\Windows\CurrentVersion\Uninstall\*"),
    ("HKLM", r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"),
    ("HKCU", r"Software\Microsoft\Windows\CurrentVersion\Uninstall\*"),
]

# 常见安装目录兜底（注册表找不到时扫描）
_COMMON_INSTALL_DIRS = [
    pathlib.Path(os.environ.get("LOCALAPPDATA", "")) / "Tencent" / "QQMusic",
    pathlib.Path(os.environ.get("PROGRAMFILES", "")) / "Tencent" / "QQMusic",
    pathlib.Path(os.environ.get("PROGRAMFILES(X86)", "")) / "Tencent" / "QQMusic",
    pathlib.Path(os.environ.get("USERPROFILE", "")) / "AppData" / "Local" / "Tencent" / "QQMusic",
]

# 等待超时配置
PROCESS_WAIT_TIMEOUT = 15  # 等进程出现（秒）
DLL_LOAD_BUFFER = 5  # 进程出现后额外等 DLL 加载（秒）
POLL_INTERVAL = 0.8  # 轮询间隔（秒）


def _query_registry_for_qqmusic_path() -> Optional[pathlib.Path]:
    """通过注册表查找 QQMusic.exe 路径。找不到返回 None（降级不报错）。"""
    if sys.platform != "win32":
        return None

    try:
        import winreg
    except ImportError:
        logger.warning("winreg 不可用，跳过注册表查询")
        return None

    access_map = {
        "HKCU": winreg.KEY_READ | winreg.KEY_WOW64_64KEY,
        "HKLM": winreg.KEY_READ | winreg.KEY_WOW64_64KEY,
    }

    for hkey_name, subkey in _REGISTRY_SEARCH_KEYS:
        hkey_const = getattr(winreg, hkey_name, None)
        if hkey_const is None:
            continue

        try:
            with winreg.OpenKey(hkey_const, subkey, 0, access_map.get(hkey_name, winreg.KEY_READ)) as key:
                # 直接查 InstallPath / AppPath / Location 等常见字段
                for value_name in ("InstallPath", "AppPath", "Location", "DisplayIcon", "ExecutablePath"):
                    try:
                        value, _ = winreg.QueryValueEx(key, value_name)
                        candidate = pathlib.Path(str(value))
                        if candidate.is_file():
                            logger.info(f"[QQ启动] 注册表命中 {hkey_name}\\{subkey} -> {candidate}")
                            return candidate
                        # 有些存的是目录，补 QQMusic.exe
                        if candidate.is_dir():
                            exe = candidate / "QQMusic.exe"
                            if exe.is_file():
                                logger.info(f"[QQ启动] 注册表命中目录 {hkey_name}\\{subkey} -> {exe}")
                                return exe
                    except FileNotFoundError:
                        continue
        except (FileNotFoundError, OSError):
            continue

        # 卸载表可能需要枚举子项
        if subkey.endswith(r"\Uninstall\*"):
            try:
                uninstall_key = winreg.OpenKey(
                    hkey_const,
                    subkey.replace(r"\Uninstall\*", r"\Uninstall"),
                    0,
                    access_map.get(hkey_name, winreg.KEY_READ),
                )
                idx = 0
                while True:
                    try:
                        subkey_name = winreg.EnumKey(uninstall_key, idx)
                        name_lower = subkey_name.lower()
                        if "qqmusic" in name_lower or "qq music" in name_lower:
                            uninstall_base = subkey.replace(r"\Uninstall\*", r"\Uninstall")
                            subkey_full = uninstall_base + "\\" + subkey_name
                            with winreg.OpenKey(hkey_const, subkey_full, 0, access_map.get(hkey_name, winreg.KEY_READ)) as sk:
                                display_icon, _ = winreg.QueryValueEx(sk, "DisplayIcon")
                                candidate = pathlib.Path(str(display_icon).split(",")[0].strip())
                                if candidate.is_file():
                                    logger.info(f"[QQ启动] 卸载表命中 -> {candidate}")
                                    return candidate
                    except FileNotFoundError:
                        break
                    idx += 1
            except (FileNotFoundError, OSError):
                continue

    logger.info("[QQ启动] 注册表未找到 QQMusic.exe")
    return None


def _scan_common_dirs_for_qqmusic() -> Optional[pathlib.Path]:
    """注册表找不到时，扫描常见安装目录兜底。"""
    for base in _COMMON_INSTALL_DIRS:
        if not base or not str(base):
            continue
        exe = base / "QQMusic.exe"
        if exe.is_file():
            logger.info(f"[QQ启动] 常见目录扫描命中 -> {exe}")
            return exe
    logger.info("[QQ启动] 常见目录扫描未找到 QQMusic.exe")
    return None


def discover_qqmusic_path() -> Optional[pathlib.Path]:
    """查找 QQMusic.exe 路径：先注册表，后常见目录。找不到返回 None。"""
    path = _query_registry_for_qqmusic_path()
    if path:
        return path
    return _scan_common_dirs_for_qqmusic()


def is_qqmusic_running() -> bool:
    """检测 QQMusic.exe 进程是否运行。"""
    info = find_process_by_name("QQMusic.exe")
    if info is not None:
        return True
    # 有些版本进程名小写或带后缀
    from src.Infrastructure.process_utils import find_process_by_substring
    return find_process_by_substring("qqmusic") is not None


def launch_qqmusic(timeout: int = PROCESS_WAIT_TIMEOUT) -> bool:
    """启动 QQ 音乐并等待进程就绪。

    返回: True 表示进程已就绪，False 表示启动失败或超时
    """
    if is_qqmusic_running():
        logger.info("[QQ启动] QQ 音乐已在运行，无需启动")
        return True

    exe_path = discover_qqmusic_path()
    if exe_path is None:
        logger.warning("[QQ启动] 未找到 QQMusic.exe，无法自动启动")
        return False

    logger.info(f"[QQ启动] 开始启动 QQ 音乐: {exe_path}")
    try:
        # 列表传参，shell=False（硬约束）
        proc = subprocess.Popen(
            [str(exe_path)],
            shell=False,
            cwd=str(exe_path.parent),
        )
        logger.info(f"[QQ启动] QQMusic.exe 已发起启动 (PID={proc.pid})")
    except (OSError, subprocess.SubprocessError) as exc:
        logger.error(f"[QQ启动] 启动失败: {exc}")
        return False

    # 轮询等待进程出现
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if is_qqmusic_running():
            logger.info("[QQ启动] QQ 音乐进程已就绪")
            # 额外等几秒让 DLL 加载（Frida attach 需要）
            logger.info(f"[QQ启动] 等待 {DLL_LOAD_BUFFER}s 让 DLL 加载完毕...")
            time.sleep(DLL_LOAD_BUFFER)
            return True
        time.sleep(POLL_INTERVAL)

    logger.warning(f"[QQ启动] 等待 QQ 音乐进程超时 ({timeout}s)")
    return False
