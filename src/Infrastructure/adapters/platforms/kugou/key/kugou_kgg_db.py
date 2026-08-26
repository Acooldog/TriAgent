from __future__ import annotations
import hashlib
import pathlib
import sqlite3
import struct
import tempfile
from functools import lru_cache
from src.Infrastructure.adapters.platforms.kugou.crypto.kugou_ciphers import (
    _AES_CBC,
    DecodeError,
    DEFAULT_MASTER_KEY,
    PAGE_SIZE,
    SQLITE_HEADER,
)

def _derive_iv_seed(seed: int) -> int:
    left = (seed * 0x9EF4) & 0xFFFFFFFF
    right = (seed // 0xCE26) * 0x7FFFFF07
    value = (left - right) & 0xFFFFFFFF
    if (value & 0x80000000) == 0:
        return value
    return (value + 0x7FFFFF07) & 0xFFFFFFFF

def _derive_page_iv(page: int) -> bytes:
    iv = bytearray(16)
    page += 1
    for offset in range(0, 16, 4):
        page = _derive_iv_seed(page)
        struct.pack_into("<I", iv, offset, page)
    return hashlib.md5(iv).digest()

def _derive_page_key(page: int) -> bytes:
    master_key = bytearray(DEFAULT_MASTER_KEY)
    struct.pack_into("<I", master_key, 0x10, page)
    return hashlib.md5(master_key).digest()

def _validate_first_page_header(header: bytes) -> None:
    o10 = struct.unpack_from("<I", header, 0x10)[0]
    o14 = struct.unpack_from("<I", header, 0x14)[0]
    v6 = ((o10 & 0xFF) << 8) | ((o10 & 0xFF00) << 16)
    ok = o14 == 0x20204000 and (v6 - 0x200) <= 0xFE00 and ((v6 - 1) & v6) == 0
    if not ok:
        raise DecodeError("invalid encrypted sqlite page 1 header")

def _decrypt_database(buffer: bytearray) -> bytearray:
    if bytes(buffer[: len(SQLITE_HEADER)]) == SQLITE_HEADER:
        return buffer
    if not buffer or len(buffer) % PAGE_SIZE != 0:
        raise DecodeError(f"invalid encrypted database size: {len(buffer)}")
    first_page = bytearray(buffer[:PAGE_SIZE])
    _validate_first_page_header(first_page)
    expected_header = bytes(first_page[0x10:0x18])
    first_page[0x10:0x18] = first_page[0x08:0x10]
    decrypted_first = _AES_CBC.decrypt(bytes(first_page[0x10:]), _derive_page_key(1), _derive_page_iv(1))
    first_page[0x10:] = decrypted_first
    if bytes(first_page[0x10:0x18]) != expected_header:
        raise DecodeError("decrypt page 1 failed")
    first_page[:0x10] = SQLITE_HEADER
    buffer[:PAGE_SIZE] = first_page
    for page_number in range(2, len(buffer) // PAGE_SIZE + 1):
        start = (page_number - 1) * PAGE_SIZE
        end = start + PAGE_SIZE
        buffer[start:end] = _AES_CBC.decrypt(bytes(buffer[start:end]), _derive_page_key(page_number), _derive_page_iv(page_number))
    return buffer

def _extract_key_mapping(decrypted_db: bytes) -> dict[str, str]:
    with tempfile.TemporaryDirectory(prefix="kgg-db-") as tmpdir:
        tmp_path = pathlib.Path(tmpdir) / "KGMusicV3.db"
        tmp_path.write_bytes(decrypted_db)
        conn = sqlite3.connect(str(tmp_path))
        try:
            rows = conn.execute(
                "select EncryptionKeyId, EncryptionKey from ShareFileItems where EncryptionKey != '' and EncryptionKey is not null"
            ).fetchall()
        finally:
            conn.close()
    return {str(key_id): str(key) for key_id, key in rows}

@lru_cache(maxsize=4)
def _load_kgg_key_mapping_cached(cache_key: tuple[str, int, int]) -> dict[str, str]:
    db_path = pathlib.Path(cache_key[0])
    buffer = bytearray(db_path.read_bytes())
    decrypted = _decrypt_database(buffer)
    return _extract_key_mapping(bytes(decrypted))

def load_kgg_key_mapping(db_path: pathlib.Path) -> dict[str, str]:
    stat = db_path.stat()
    cache_key = (str(db_path.resolve()), stat.st_size, stat.st_mtime_ns)
    return _load_kgg_key_mapping_cached(cache_key)

__all__ = [
    "load_kgg_key_mapping",
    "_decrypt_database",
    "_extract_key_mapping",
    "_load_kgg_key_mapping_cached",
    "_derive_iv_seed",
    "_derive_page_iv",
    "_derive_page_key",
    "_validate_first_page_header",
]
