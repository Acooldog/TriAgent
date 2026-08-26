"""QQ音乐解密器 - Python版本 (重导出层)

使用Frida调用QQMusicCommon.dll中的EncAndDesMediaFile类来解密加密音频文件
"""

from __future__ import annotations

from src.Infrastructure.adapters.platforms.qq.runtime.qq_decryptor import (
    Decryptor_main,
    QQMusicDecryptor,
    is_ascii_path,
    pick_safe_tmp_dir,
)


__all__ = [
    "QQMusicDecryptor",
    "Decryptor_main",
    "is_ascii_path",
    "pick_safe_tmp_dir",
]
