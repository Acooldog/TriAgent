from __future__ import annotations

import base64
import ctypes
import struct


class DecodeError(RuntimeError):
    pass


class _AesCbcNoPadding:
    def __init__(self) -> None:
        self.bcrypt = ctypes.WinDLL("bcrypt")
        self.alg_handle = ctypes.c_void_p()
        self.object_length = ctypes.c_ulong()
        self.block_length = ctypes.c_ulong()
        self._open_provider()

    def _check(self, status: int, action: str) -> None:
        if status != 0:
            raise DecodeError(f"bcrypt {action} failed: 0x{status & 0xFFFFFFFF:08x}")

    def _open_provider(self) -> None:
        result = ctypes.c_ulong()
        status = self.bcrypt.BCryptOpenAlgorithmProvider(
            ctypes.byref(self.alg_handle),
            ctypes.c_wchar_p("AES"),
            None,
            0,
        )
        self._check(status, "open algorithm provider")
        mode = ctypes.create_unicode_buffer("ChainingModeCBC")
        status = self.bcrypt.BCryptSetProperty(
            self.alg_handle,
            ctypes.c_wchar_p("ChainingMode"),
            ctypes.cast(mode, ctypes.POINTER(ctypes.c_ubyte)),
            ctypes.sizeof(mode),
            0,
        )
        self._check(status, "set chaining mode")
        status = self.bcrypt.BCryptGetProperty(
            self.alg_handle,
            ctypes.c_wchar_p("ObjectLength"),
            ctypes.byref(self.object_length),
            ctypes.sizeof(self.object_length),
            ctypes.byref(result),
            0,
        )
        self._check(status, "get object length")
        status = self.bcrypt.BCryptGetProperty(
            self.alg_handle,
            ctypes.c_wchar_p("BlockLength"),
            ctypes.byref(self.block_length),
            ctypes.sizeof(self.block_length),
            ctypes.byref(result),
            0,
        )
        self._check(status, "get block length")

    def decrypt(self, buffer: bytes | bytearray, key: bytes, iv: bytes) -> bytes:
        if len(key) != 16:
            raise DecodeError(f"invalid AES key size: {len(key)}")
        if len(iv) != int(self.block_length.value):
            raise DecodeError(f"invalid AES IV size: {len(iv)}")
        if len(buffer) % int(self.block_length.value) != 0:
            raise DecodeError("AES CBC buffer must align to block size")
        key_handle = ctypes.c_void_p()
        key_object = (ctypes.c_ubyte * int(self.object_length.value))()
        key_bytes = (ctypes.c_ubyte * len(key)).from_buffer_copy(key)
        status = self.bcrypt.BCryptGenerateSymmetricKey(
            self.alg_handle,
            ctypes.byref(key_handle),
            key_object,
            len(key_object),
            key_bytes,
            len(key),
            0,
        )
        self._check(status, "generate symmetric key")
        try:
            iv_bytes = (ctypes.c_ubyte * len(iv)).from_buffer_copy(iv)
            src = (ctypes.c_ubyte * len(buffer)).from_buffer_copy(bytes(buffer))
            dst = (ctypes.c_ubyte * len(buffer))()
            out_len = ctypes.c_ulong()
            status = self.bcrypt.BCryptDecrypt(
                key_handle, src, len(buffer), None, iv_bytes, len(iv),
                dst, len(buffer), ctypes.byref(out_len), 0,
            )
            self._check(status, "decrypt")
            return bytes(dst[: out_len.value])
        finally:
            self.bcrypt.BCryptDestroyKey(key_handle)

    def close(self) -> None:
        if self.alg_handle:
            self.bcrypt.BCryptCloseAlgorithmProvider(self.alg_handle, 0)
            self.alg_handle = ctypes.c_void_p()


def _rotate_byte(value: int, bits: int) -> int:
    return ((value << bits) & 0xFF) | (value >> (8 - bits))


def _simple_make_key(salt: int, length: int) -> bytes:
    import math
    return bytes(int(abs(math.tan(float(salt) + float(i) * 0.1)) * 100.0) & 0xFF for i in range(length))


def _tea_decrypt_block(block: bytes, key: bytes, rounds: int = 32) -> bytes:
    if len(block) != 8 or len(key) != 16:
        raise DecodeError("invalid TEA block or key size")
    v0, v1 = struct.unpack(">2I", block)
    k0, k1, k2, k3 = struct.unpack(">4I", key)
    delta = 0x9E3779B9
    total = (delta * (rounds // 2)) & 0xFFFFFFFF
    for _ in range(rounds // 2):
        v1 = (v1 - ((((v0 << 4) + k2) & 0xFFFFFFFF) ^ ((v0 + total) & 0xFFFFFFFF) ^ (((v0 >> 5) + k3) & 0xFFFFFFFF))) & 0xFFFFFFFF
        v0 = (v0 - ((((v1 << 4) + k0) & 0xFFFFFFFF) ^ ((v1 + total) & 0xFFFFFFFF) ^ (((v1 >> 5) + k1) & 0xFFFFFFFF))) & 0xFFFFFFFF
        total = (total - delta) & 0xFFFFFFFF
    return struct.pack(">2I", v0, v1)


def _xor8(a: bytes, b: bytes) -> bytes:
    return bytes(x ^ y for x, y in zip(a, b))


def _decrypt_tencent_tea(buffer: bytes, key: bytes) -> bytes:
    if len(buffer) % 8 != 0:
        raise DecodeError("Tencent TEA input size must align to 8 bytes")
    if len(buffer) < 16:
        raise DecodeError("Tencent TEA input size too small")
    first = _tea_decrypt_block(buffer[:8], key)
    pad_len = first[0] & 0x7
    out_len = len(buffer) - 1 - pad_len - 2 - 7
    out = bytearray(out_len)
    iv_prev = b"\x00" * 8
    iv_cur = buffer[:8]
    in_pos = 8
    dest = bytearray(first)
    dest_idx = 1 + pad_len

    def crypt_block() -> None:
        nonlocal in_pos, dest_idx, iv_prev, iv_cur, dest
        iv_prev = iv_cur
        iv_cur = buffer[in_pos:in_pos + 8]
        xored = _xor8(dest, iv_cur)
        dest = bytearray(_tea_decrypt_block(xored, key))
        in_pos += 8
        dest_idx = 0

    consumed_salt = 0
    while consumed_salt < 2:
        if dest_idx < 8:
            dest_idx += 1
            consumed_salt += 1
        else:
            crypt_block()

    out_pos = 0
    while out_pos < out_len:
        if dest_idx < 8:
            out[out_pos] = dest[dest_idx] ^ iv_prev[dest_idx]
            dest_idx += 1
            out_pos += 1
        else:
            crypt_block()

    for _ in range(7):
        if dest_idx == 8:
            crypt_block()
        if (dest[dest_idx] ^ iv_prev[dest_idx]) != 0:
            raise DecodeError("Tencent TEA zero check failed")
        dest_idx += 1

    return bytes(out)


def _derive_key_v1(raw: bytes) -> bytes:
    if len(raw) < 16:
        raise DecodeError("qmc raw key too short")
    simple = _simple_make_key(106, 8)
    tea_key = bytearray(16)
    for i in range(8):
        tea_key[i * 2] = simple[i]
        tea_key[i * 2 + 1] = raw[i]
    tail = _decrypt_tencent_tea(raw[8:], bytes(tea_key))
    return raw[:8] + tail


def _derive_key_v2(raw: bytes) -> bytes:
    key1 = bytes([0x33, 0x38, 0x36, 0x5A, 0x4A, 0x59, 0x21, 0x40, 0x23, 0x2A, 0x24, 0x25, 0x5E, 0x26, 0x29, 0x28])
    key2 = bytes([0x2A, 0x2A, 0x23, 0x21, 0x28, 0x23, 0x24, 0x25, 0x26, 0x5E, 0x61, 0x31, 0x63, 0x5A, 0x2C, 0x54])
    step1 = _decrypt_tencent_tea(raw, key1)
    step2 = _decrypt_tencent_tea(step1, key2)
    return base64.b64decode(step2)


_AES_CBC = _AesCbcNoPadding()


__all__ = [
    "DecodeError",
    "_AesCbcNoPadding",
    "_AES_CBC",
    "_rotate_byte",
    "_simple_make_key",
    "_tea_decrypt_block",
    "_xor8",
    "_decrypt_tencent_tea",
    "_derive_key_v1",
    "_derive_key_v2",
]
