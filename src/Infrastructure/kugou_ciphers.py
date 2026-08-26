from __future__ import annotations

import base64
import lzma
import pathlib
from functools import lru_cache

from src.Infrastructure.kugou_crypto import (
    DecodeError,
    _AesCbcNoPadding,
    _AES_CBC,
    _decrypt_tencent_tea,
    _derive_key_v1,
    _derive_key_v2,
    _rotate_byte,
    _simple_make_key,
    _tea_decrypt_block,
    _xor8,
)
from src.Infrastructure.kugou_tables import (
    DEFAULT_KGG_DB_PATH,
    DEFAULT_KEY_PATH,
    DEFAULT_MASTER_KEY,
    DEFAULT_OUTPUT_DIR,
    HEADER_LEN,
    KGM_MAGIC,
    KugouHeader,
    OUTPUT_AUDIO_EXTENSIONS,
    OWN_KEY_LEN,
    PAGE_SIZE,
    PATHS,
    PUB_KEY_LEN,
    PUB_KEY_LEN_MAGNIFICATION,
    PUB_KEY_MEND,
    STATIC_CIPHER_BOX,
    SUPPORTED_SUFFIXES,
    SQLITE_HEADER,
    V3_STREAM_CHUNK_SIZE,
    V5_STREAM_CHUNK_SIZE,
    VPR_MAGIC,
    np,
)
from src.Infrastructure.native_backend import NativeBackendError, get_native_backend


class UnrecognizedAudioContainerError(DecodeError):
    def __init__(self, summary: dict):
        super().__init__("unrecognized_audio_container")
        self.summary = summary


class StreamCipher:
    def decrypt(self, data: bytearray, offset: int) -> None:
        raise NotImplementedError


class StaticCipher(StreamCipher):
    BOX = STATIC_CIPHER_BOX

    def decrypt(self, data: bytearray, offset: int) -> None:
        for i in range(len(data)):
            pos = offset + i
            if pos > 0x7FFF:
                pos %= 0x7FFF
            idx = (pos * pos + 27) & 0xFF
            data[i] ^= self.BOX[idx]


class MapCipher(StreamCipher):
    def __init__(self, key: bytes, *, use_native: bool = True) -> None:
        if not key:
            raise DecodeError("qmc map cipher key is empty")
        self.key = key
        self.size = len(key)
        self.use_native = use_native
        self.native_backend = get_native_backend()

    @staticmethod
    def _rotate(value: int, bits: int) -> int:
        rotate = (bits + 4) % 8
        return ((value << rotate) & 0xFF) | (value >> rotate)

    def _mask(self, offset: int) -> int:
        if offset > 0x7FFF:
            offset %= 0x7FFF
        idx = (offset * offset + 71214) % self.size
        return self._rotate(self.key[idx], idx & 0x7)

    def decrypt(self, data: bytearray, offset: int) -> None:
        if self.use_native and self.native_backend.available:
            try:
                self.native_backend.map_decrypt_inplace(data, len(data), self.key, offset)
                return
            except NativeBackendError:
                pass
        for i in range(len(data)):
            data[i] ^= self._mask(offset + i)


class RC4Cipher(StreamCipher):
    SEGMENT_SIZE = 5120
    FIRST_SEGMENT_SIZE = 128

    def __init__(self, key: bytes, *, use_native: bool = True) -> None:
        if not key:
            raise DecodeError("qmc rc4 cipher key is empty")
        self.key = key
        self.n = len(key)
        self.use_native = use_native
        self.native_backend = get_native_backend()
        self.box = [i & 0xFF for i in range(self.n)]
        j = 0
        for i in range(self.n):
            j = (j + self.box[i] + key[i % self.n]) % self.n
            self.box[i], self.box[j] = self.box[j], self.box[i]
        self.hash_base = 1
        for value in key:
            if value == 0:
                continue
            next_hash = (self.hash_base * value) & 0xFFFFFFFF
            if next_hash == 0 or next_hash <= self.hash_base:
                break
            self.hash_base = next_hash

    def _get_segment_skip(self, idx: int) -> int:
        seed = self.key[idx % self.n]
        value = int(float(self.hash_base) / float((idx + 1) * seed) * 100.0)
        return value % self.n

    def _decrypt_first_segment(self, data: bytearray, offset: int) -> None:
        for i in range(len(data)):
            data[i] ^= self.key[self._get_segment_skip(offset + i)]

    def _decrypt_segment(self, data: bytearray, offset: int) -> None:
        box = self.box[:]
        j = 0
        k = 0
        skip = (offset % self.SEGMENT_SIZE) + self._get_segment_skip(offset // self.SEGMENT_SIZE)
        for i in range(-skip, len(data)):
            j = (j + 1) % self.n
            k = (box[j] + k) % self.n
            box[j], box[k] = box[k], box[j]
            if i >= 0:
                data[i] ^= box[(box[j] + box[k]) % self.n]

    def decrypt(self, data: bytearray, offset: int) -> None:
        if self.use_native and self.native_backend.available:
            try:
                self.native_backend.rc4_decrypt_inplace(data, len(data), self.key, offset)
                return
            except NativeBackendError:
                pass
        view_offset = offset
        processed = 0
        to_process = len(data)
        if view_offset < self.FIRST_SEGMENT_SIZE:
            block = min(to_process, self.FIRST_SEGMENT_SIZE - view_offset)
            chunk = data[:block]
            self._decrypt_first_segment(chunk, view_offset)
            data[:block] = chunk
            view_offset += block
            processed += block
            to_process -= block
        if to_process <= 0:
            return
        if view_offset % self.SEGMENT_SIZE != 0:
            block = min(to_process, self.SEGMENT_SIZE - (view_offset % self.SEGMENT_SIZE))
            chunk = data[processed:processed + block]
            self._decrypt_segment(chunk, view_offset)
            data[processed:processed + block] = chunk
            view_offset += block
            processed += block
            to_process -= block
        while to_process > self.SEGMENT_SIZE:
            chunk = data[processed:processed + self.SEGMENT_SIZE]
            self._decrypt_segment(chunk, view_offset)
            data[processed:processed + self.SEGMENT_SIZE] = chunk
            view_offset += self.SEGMENT_SIZE
            processed += self.SEGMENT_SIZE
            to_process -= self.SEGMENT_SIZE
        if to_process > 0:
            chunk = data[processed:]
            self._decrypt_segment(chunk, view_offset)
            data[processed:] = chunk


def _derive_key(raw_key: bytes) -> bytes:
    raw = base64.b64decode(raw_key)
    prefix = b"QQMusic EncV2,Key:"
    if raw.startswith(prefix):
        raw = _derive_key_v2(raw[len(prefix):])
    return _derive_key_v1(raw)


def _new_qmc_cipher_from_ekey(ekey: str | bytes, *, use_native: bool = True) -> StreamCipher:
    raw = ekey.encode("utf-8") if isinstance(ekey, str) else ekey
    key = _derive_key(raw)
    if len(key) > 300:
        return RC4Cipher(key, use_native=use_native)
    if key:
        return MapCipher(key, use_native=use_native)
    return StaticCipher()


@lru_cache(maxsize=4)
def _load_public_key_cached(cache_key: tuple[str, int, int]) -> bytes:
    return lzma.decompress(pathlib.Path(cache_key[0]).read_bytes())


def load_public_key(path: pathlib.Path) -> bytes:
    stat = path.stat()
    cache_key = (str(path.resolve()), stat.st_size, stat.st_mtime_ns)
    return _load_public_key_cached(cache_key)


# Re-export everything consumed externally
__all__ = [
    "PATHS",
    "DEFAULT_KEY_PATH",
    "DEFAULT_OUTPUT_DIR",
    "DEFAULT_KGG_DB_PATH",
    "HEADER_LEN",
    "KGM_MAGIC",
    "VPR_MAGIC",
    "SUPPORTED_SUFFIXES",
    "OUTPUT_AUDIO_EXTENSIONS",
    "V3_STREAM_CHUNK_SIZE",
    "V5_STREAM_CHUNK_SIZE",
    "OWN_KEY_LEN",
    "PUB_KEY_LEN",
    "PUB_KEY_LEN_MAGNIFICATION",
    "PUB_KEY_MEND",
    "PAGE_SIZE",
    "SQLITE_HEADER",
    "DEFAULT_MASTER_KEY",
    "DecodeError",
    "UnrecognizedAudioContainerError",
    "StreamCipher",
    "StaticCipher",
    "MapCipher",
    "RC4Cipher",
    "_AES_CBC",
    "_rotate_byte",
    "_simple_make_key",
    "_tea_decrypt_block",
    "_xor8",
    "_decrypt_tencent_tea",
    "_derive_key",
    "_derive_key_v1",
    "_derive_key_v2",
    "_new_qmc_cipher_from_ekey",
    "KugouHeader",
    "load_public_key",
    "_load_public_key_cached",
    "_AesCbcNoPadding",
    "np",
]
