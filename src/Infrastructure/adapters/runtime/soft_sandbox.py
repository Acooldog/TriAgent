"""软沙箱管理器：限制文件操作的路径范围。

安全机制：所有文件操作（读取、写入、删除、复制等）都必须在授权目录范围内。
支持多目录授权、动态添加/移除、路径验证等功能。
"""
from __future__ import annotations

import pathlib
import threading
from typing import Optional


class SoftSandbox:
    """软沙箱：限制文件操作的路径范围。

    使用方法：
    1. 创建实例并授权目录
    2. 在文件操作前调用 validate_path() 验证路径
    3. 未授权路径会抛出 PermissionError

    线程安全：支持多线程环境下的并发访问。
    """

    def __init__(self) -> None:
        self._authorized_paths: list[pathlib.Path] = []
        self._lock = threading.RLock()
        self._enabled: bool = True

    @property
    def enabled(self) -> bool:
        """沙箱是否启用。"""
        return self._enabled

    @enabled.setter
    def enabled(self, value: bool) -> None:
        with self._lock:
            self._enabled = value

    @property
    def authorized_paths(self) -> list[pathlib.Path]:
        """获取所有授权目录。"""
        with self._lock:
            return list(self._authorized_paths)

    def add_path(self, path: str | pathlib.Path) -> bool:
        """添加授权目录。

        如果目录不存在会自动创建，确保 Agent 可以授权并使用新目录。

        Returns:
            True if the path was newly added, False if already authorized.
        """
        path_obj = pathlib.Path(path).expanduser().resolve()
        if not path_obj.exists():
            # 自动创建不存在的目录
            path_obj.mkdir(parents=True, exist_ok=True)
            print(f"[SoftSandbox] 自动创建目录: {path_obj}")
        if not path_obj.is_dir():
            raise ValueError(f"路径不是目录: {path_obj}")
        with self._lock:
            # 检查是否已存在或为已有路径的子目录
            for existing in self._authorized_paths:
                if path_obj == existing or path_obj in existing.parents:
                    return False  # 已包含，无需重复添加
                if existing in path_obj.parents:
                    return False  # 父目录已授权，无需重复添加
            self._authorized_paths.append(path_obj)
            print(f"[SoftSandbox] 添加授权目录: {path_obj}")
            return True

    def remove_path(self, path: str | pathlib.Path) -> bool:
        """移除授权目录。

        Args:
            path: 目录路径

        Returns:
            是否成功移除
        """
        path_obj = pathlib.Path(path).expanduser().resolve()
        with self._lock:
            for i, existing in enumerate(self._authorized_paths):
                if existing == path_obj:
                    self._authorized_paths.pop(i)
                    print(f"[SoftSandbox] 移除授权目录: {path_obj}")
                    return True
            return False

    def clear(self) -> None:
        """清空所有授权目录。"""
        with self._lock:
            self._authorized_paths.clear()
            print("[SoftSandbox] 清空所有授权目录")

    def is_path_authorized(self, path: str | pathlib.Path) -> bool:
        """检查路径是否在授权范围内。

        Args:
            path: 要检查的路径

        Returns:
            是否授权
        """
        if not self._enabled:
            return True  # 沙箱未启用时所有路径都授权

        path_obj = pathlib.Path(path).expanduser().resolve()
        with self._lock:
            for authorized in self._authorized_paths:
                try:
                    path_obj.relative_to(authorized)
                    return True
                except ValueError:
                    continue
        return False

    def validate_path(self, path: str | pathlib.Path, operation: str = "操作") -> pathlib.Path:
        """验证路径是否在授权范围内。

        Args:
            path: 要验证的路径
            operation: 操作描述（用于错误消息）

        Returns:
            验证后的解析路径

        Raises:
            PermissionError: 路径未授权
            ValueError: 路径不存在
        """
        path_obj = pathlib.Path(path).expanduser().resolve()

        if not self._enabled:
            return path_obj

        if not self._authorized_paths:
            raise PermissionError(
                f"沙箱已启用但未授权任何目录。"
                f"请先通过 add_path() 授权至少一个目录。"
            )

        if not self.is_path_authorized(path_obj):
            authorized_str = ", ".join(str(p) for p in self._authorized_paths)
            raise PermissionError(
                f"路径未授权: {path_obj}\n"
                f"授权目录: {authorized_str}\n"
                f"如需访问此路径，请先授权其父目录。"
            )

        # 检查路径是否存在（对于写操作可能不存在，所以只检查父目录）
        if not path_obj.exists() and not path_obj.parent.exists():
            raise ValueError(f"路径和父目录都不存在: {path_obj}")

        print(f"[SoftSandbox] {operation} 路径验证通过: {path_obj}")
        return path_obj

    def validate_output_path(self, path: str | pathlib.Path) -> pathlib.Path:
        """验证输出路径（允许文件不存在，但父目录必须授权）。

        Args:
            path: 输出路径

        Returns:
            验证后的解析路径

        Raises:
            PermissionError: 父目录未授权
        """
        path_obj = pathlib.Path(path).expanduser().resolve()
        if not self._enabled:
            return path_obj

        # 检查父目录是否授权
        parent = path_obj.parent
        if not self.is_path_authorized(parent):
            authorized_str = ", ".join(str(p) for p in self._authorized_paths)
            raise PermissionError(
                f"输出路径的父目录未授权: {parent}\n"
                f"授权目录: {authorized_str}"
            )

        return path_obj

    def get_status(self) -> dict:
        """获取沙箱状态信息。"""
        return {
            "enabled": self._enabled,
            "authorized_paths": [str(p) for p in self._authorized_paths],
            "paths_count": len(self._authorized_paths),
        }


# 全局沙箱实例（线程安全）
_sandbox: Optional[SoftSandbox] = None
_sandbox_lock = threading.Lock()


def get_sandbox() -> SoftSandbox:
    """获取全局软沙箱实例。"""
    global _sandbox
    if _sandbox is None:
        with _sandbox_lock:
            if _sandbox is None:
                _sandbox = SoftSandbox()
    return _sandbox


def reset_sandbox() -> SoftSandbox:
    """重置全局软沙箱实例。"""
    global _sandbox
    with _sandbox_lock:
        _sandbox = SoftSandbox()
        print("[SoftSandbox] 全局沙箱已重置")
    return _sandbox
