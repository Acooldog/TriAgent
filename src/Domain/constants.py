from __future__ import annotations

import os
import pathlib


# --- Project metadata ---
CONFIG_NAMESPACE = "decrypt_cli"
PROJECT_NAME_EN = "QKKDecrypt"
PROJECT_NAME_ZH = "QQ酷狗酷我网易云音乐解密工具"
PROJECT_ADDRESS = "https://github.com/Acooldog/QQKWKG-TriMusicDecrypt"
PROJECT_QQ = "2622138410"
QQMUSIC_ATTRIBUTION = "QQ 音乐解密模型思路参考项目：qqmusic_decrypt（https://github.com/luyikk/qqmusic_decrypt）"
LEGAL_NOTICE = "其他模型为自主逆向学习实现，仅供学习交流使用；禁止商用，禁止倒卖，倒卖者将举报平台并持续追责。\n格式说明：m4a/mp3/flac 支持补封面；m4a/wav 支持补专辑信息，均优先本地后网络。"
FLET_NOTE = "main-ui 分支采用 PySide6。PySide6 基于 Qt for Python，桌面界面由本地 Qt 窗口和 Python 业务逻辑直接驱动。"

# 默认路径：基于用户主目录的通用路径，用户可在配置中修改
_USER_HOME = pathlib.Path(os.path.expanduser("~"))
DEFAULT_KUGOU_INPUT = _USER_HOME / "KuGou" / "KugouMusic"
DEFAULT_KUWO_INPUT = pathlib.Path("")  # 酷我无稳定默认路径，需用户配置
DEFAULT_QQ_INPUT = pathlib.Path("")  # QQ 音乐需运行客户端，路径由用户配置
DEFAULT_NETEASE_INPUT = pathlib.Path("")  # 网易云路径需用户配置

TRANSCODE_SAMPLE_RATE_OPTIONS: tuple[int, ...] = (22050, 32000, 44100, 48000, 88200, 96000)
TRANSCODE_BITRATE_OPTIONS: tuple[int, ...] = (96, 128, 160, 192, 256, 320)


__all__ = [
    "CONFIG_NAMESPACE",
    "DEFAULT_KUGOU_INPUT",
    "DEFAULT_KUWO_INPUT",
    "DEFAULT_NETEASE_INPUT",
    "DEFAULT_QQ_INPUT",
    "FLET_NOTE",
    "LEGAL_NOTICE",
    "PROJECT_ADDRESS",
    "PROJECT_NAME_EN",
    "PROJECT_NAME_ZH",
    "PROJECT_QQ",
    "QQMUSIC_ATTRIBUTION",
    "TRANSCODE_BITRATE_OPTIONS",
    "TRANSCODE_SAMPLE_RATE_OPTIONS",
]
