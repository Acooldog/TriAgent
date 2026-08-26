"""移植自 unlock-music 项目的酷我 KWM 解密实现（纯算法，无需运行酷我客户端）。

算法来源：https://github.com/inkpixe1/unlock-music/blob/main/src/decrypt/kwm.ts
仅供学习与研究使用，使用者需自行承担版权合规责任。
"""
from __future__ import annotations

import pathlib


MAGIC_HEADER_1 = bytes([
    0x79, 0x65, 0x65, 0x6C, 0x69, 0x6F, 0x6E, 0x2D,
    0x6B, 0x75, 0x77, 0x6F, 0x2D, 0x74, 0x6D, 0x65,
])
MAGIC_HEADER_2 = bytes([
    0x79, 0x65, 0x65, 0x6C, 0x69, 0x6F, 0x6E, 0x2D,
    0x6B, 0x75, 0x77, 0x6F, 0x00, 0x00, 0x00, 0x00,
])
PRE_DEFINED_KEY = b"MoOtOiTvINGwd2E6n0E1i7L5t2IoOoNk"

HEADER_LEN = 0x400
KEY_OFFSET = 0x18
KEY_LENGTH = 0x08
MASK_LENGTH = 0x20


def is_kwm_file(head: bytes) -> bool:
    return head[:len(MAGIC_HEADER_1)] == MAGIC_HEADER_1 or head[:len(MAGIC_HEADER_2)] == MAGIC_HEADER_2


def _trim_key(key_str: str) -> str:
    if len(key_str) > MASK_LENGTH:
        return key_str[:MASK_LENGTH]
    if len(key_str) < MASK_LENGTH:
        out = list(key_str)
        i = 0
        while len(out) < MASK_LENGTH:
            out.append(key_str[i % len(key_str)])
            i += 1
        return "".join(out)
    return key_str


def _create_mask_from_key(file_key: bytes) -> bytes:
    if len(file_key) != KEY_LENGTH:
        raise ValueError(f"file key must be {KEY_LENGTH} bytes, got {len(file_key)}")
    key_int = int.from_bytes(file_key, byteorder="little", signed=False)
    key_str = str(key_int)
    key_str_trim = _trim_key(key_str)
    if len(key_str_trim) != MASK_LENGTH:
        key_str_trim = key_str_trim.ljust(MASK_LENGTH, "\x00")
    mask = bytearray(MASK_LENGTH)
    for i in range(MASK_LENGTH):
        mask[i] = PRE_DEFINED_KEY[i] ^ ord(key_str_trim[i])
    return bytes(mask)


def decrypt_kwm_bytes(data: bytes) -> bytes:
    if not is_kwm_file(data[:max(len(MAGIC_HEADER_1), len(MAGIC_HEADER_2))]):
        raise ValueError("not a valid kwm file: magic header mismatch")
    file_key = data[KEY_OFFSET:KEY_OFFSET + KEY_LENGTH]
    mask = _create_mask_from_key(file_key)
    audio_data = data[HEADER_LEN:]
    return _xor_with_mask(audio_data, mask)


def _xor_with_mask(data: bytes, mask: bytes) -> bytes:
    try:
        import numpy as np
        arr = np.frombuffer(data, dtype=np.uint8).copy()
        mask_arr = np.frombuffer(mask, dtype=np.uint8)
        arr ^= mask_arr[np.arange(len(arr)) % MASK_LENGTH]
        return arr.tobytes()
    except ImportError:
        out = bytearray(data)
        for i in range(len(out)):
            out[i] ^= mask[i % MASK_LENGTH]
        return bytes(out)


def _sniff_audio_ext(data: bytes) -> str:
    from src.Infrastructure.transcoder import fast_detect_container_from_bytes

    container = fast_detect_container_from_bytes(data[:64])
    return container if container != "bin" else "mp3"


def decrypt_kwm_file(input_path: pathlib.Path, output_path: pathlib.Path) -> tuple[pathlib.Path, str]:
    raw = input_path.read_bytes()
    decrypted = decrypt_kwm_bytes(raw)
    ext = _sniff_audio_ext(decrypted)
    final_path = output_path.with_suffix(f".{ext}")
    final_path.parent.mkdir(parents=True, exist_ok=True)
    final_path.write_bytes(decrypted)
    return final_path, ext
