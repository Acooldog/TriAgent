from __future__ import annotations
import hashlib
import pathlib
import struct
from typing import BinaryIO
from src.Infrastructure.kugou_ciphers import (
    DecodeError,
    HEADER_LEN,
    KGM_MAGIC,
    KugouHeader,
    PUB_KEY_LEN_MAGNIFICATION,
    StreamCipher,
    V3_STREAM_CHUNK_SIZE,
    V5_STREAM_CHUNK_SIZE,
    VPR_MAGIC,
)
from src.Infrastructure.kugou_tables import (
    _build_own_transform_tables,
    _build_pub_transform_tables,
    _build_v3_block_phase_tables,
    _build_v3_numpy_lut,
)
from src.Infrastructure.kugou_kgg_db import (
    _decrypt_database,
    _derive_iv_seed,
    _derive_page_iv,
    _derive_page_key,
    _extract_key_mapping,
    _load_kgg_key_mapping_cached,
    _validate_first_page_header,
    load_kgg_key_mapping,
)
from src.Infrastructure.native_backend import NativeBackendError, get_native_backend

def detect_extension(head: bytes, fallback: str = "bin") -> str:
    if head.startswith(b"fLaC"):
        return "flac"
    if head.startswith(b"OggS"):
        return "ogg"
    if head.startswith(b"RIFF") and head[8:12] == b"WAVE":
        return "wav"
    if head.startswith(b"ID3"):
        return "mp3"
    if len(head) >= 2 and head[0] == 0xFF and head[1] in (0xFB, 0xF3, 0xF2):
        return "mp3"
    if b"ftyp" in head[:64]:
        return "m4a"
    return fallback

def _decode_v3_chunk(
    data: bytearray,
    own_key: bytes,
    pub_key: bytes,
    start_pos: int,
    data_len: int | None = None,
    *,
    use_native: bool = True,
) -> tuple[bool, str | None]:
    length = len(data) if data_len is None else data_len
    native_backend = get_native_backend()
    fallback_reason = None
    if use_native and native_backend.available:
        try:
            native_backend.decode_v3_inplace(data, length, own_key, pub_key, start_pos)
            return True, None
        except NativeBackendError as exc:
            fallback_reason = str(exc)
    own_tables = _build_own_transform_tables(own_key)
    pub_tables = _build_pub_transform_tables()
    phase_tables = _build_v3_block_phase_tables(own_key)
    numpy_lut = _build_v3_numpy_lut(own_key)
    own_len = len(own_tables)
    pub_len = len(pub_key)
    mend_len = len(pub_tables)
    total = length
    data_view = memoryview(data)
    offset = 0
    pos = start_pos
    while offset < total and (pos & 0x0F) != 0:
        pub_index = pos // PUB_KEY_LEN_MAGNIFICATION
        if pub_index >= pub_len:
            raise DecodeError("public key exhausted for current file size")
        pub_value = pub_key[pub_index]
        own_table = own_tables[pos % own_len]
        pub_value_table = pub_tables[pos % mend_len]
        data_view[offset] = own_table[data_view[offset]] ^ pub_value_table[pub_value]
        offset += 1
        pos += 1
    block_index = pos // PUB_KEY_LEN_MAGNIFICATION
    if numpy_lut is not None:
        import numpy as np
        full_blocks = (total - offset) // PUB_KEY_LEN_MAGNIFICATION
        if block_index + full_blocks > pub_len:
            raise DecodeError("public key exhausted for current file size")
        if full_blocks > 0:
            data_arr = np.frombuffer(data, dtype=np.uint8, count=full_blocks * PUB_KEY_LEN_MAGNIFICATION, offset=offset)
            block_view = data_arr.reshape(-1, PUB_KEY_LEN_MAGNIFICATION)
            pub_arr = np.frombuffer(pub_key, dtype=np.uint8)
            phase_base = block_index % 17
            for phase in range(17):
                row_start = (phase - phase_base) % 17
                if row_start >= full_blocks:
                    continue
                rows = block_view[row_start::17]
                pub_seq = pub_arr[block_index + row_start:block_index + full_blocks:17]
                phase_lut = numpy_lut[phase]
                for column in range(PUB_KEY_LEN_MAGNIFICATION):
                    rows[:, column] = phase_lut[column][pub_seq, rows[:, column]]
            offset += full_blocks * PUB_KEY_LEN_MAGNIFICATION
            pos += full_blocks * PUB_KEY_LEN_MAGNIFICATION
            block_index += full_blocks
    while offset + PUB_KEY_LEN_MAGNIFICATION <= total:
        if block_index >= pub_len:
            raise DecodeError("public key exhausted for current file size")
        phase = block_index % 17
        own_phase, pub_phase = phase_tables[phase]
        pub_value = pub_key[block_index]
        own0, own1, own2, own3, own4, own5, own6, own7, own8, own9, own10, own11, own12, own13, own14, own15 = own_phase
        pub0, pub1, pub2, pub3, pub4, pub5, pub6, pub7, pub8, pub9, pub10, pub11, pub12, pub13, pub14, pub15 = pub_phase
        data_view[offset + 0] = own0[data_view[offset + 0]] ^ pub0[pub_value]
        data_view[offset + 1] = own1[data_view[offset + 1]] ^ pub1[pub_value]
        data_view[offset + 2] = own2[data_view[offset + 2]] ^ pub2[pub_value]
        data_view[offset + 3] = own3[data_view[offset + 3]] ^ pub3[pub_value]
        data_view[offset + 4] = own4[data_view[offset + 4]] ^ pub4[pub_value]
        data_view[offset + 5] = own5[data_view[offset + 5]] ^ pub5[pub_value]
        data_view[offset + 6] = own6[data_view[offset + 6]] ^ pub6[pub_value]
        data_view[offset + 7] = own7[data_view[offset + 7]] ^ pub7[pub_value]
        data_view[offset + 8] = own8[data_view[offset + 8]] ^ pub8[pub_value]
        data_view[offset + 9] = own9[data_view[offset + 9]] ^ pub9[pub_value]
        data_view[offset + 10] = own10[data_view[offset + 10]] ^ pub10[pub_value]
        data_view[offset + 11] = own11[data_view[offset + 11]] ^ pub11[pub_value]
        data_view[offset + 12] = own12[data_view[offset + 12]] ^ pub12[pub_value]
        data_view[offset + 13] = own13[data_view[offset + 13]] ^ pub13[pub_value]
        data_view[offset + 14] = own14[data_view[offset + 14]] ^ pub14[pub_value]
        data_view[offset + 15] = own15[data_view[offset + 15]] ^ pub15[pub_value]
        offset += PUB_KEY_LEN_MAGNIFICATION
        pos += PUB_KEY_LEN_MAGNIFICATION
        block_index += 1
    while offset < total:
        pub_index = pos // PUB_KEY_LEN_MAGNIFICATION
        if pub_index >= pub_len:
            raise DecodeError("public key exhausted for current file size")
        pub_value = pub_key[pub_index]
        own_table = own_tables[pos % own_len]
        pub_value_table = pub_tables[pos % mend_len]
        data_view[offset] = own_table[data_view[offset]] ^ pub_value_table[pub_value]
        offset += 1
        pos += 1
    return False, fallback_reason

def parse_header_bytes(header: bytes) -> KugouHeader:
    if len(header) != HEADER_LEN:
        raise DecodeError("header length mismatch")
    magic = header[:16]
    if magic not in {KGM_MAGIC, VPR_MAGIC}:
        raise DecodeError("unsupported kugou file header")
    audio_offset, crypto_version, crypto_slot = struct.unpack_from("<III", header, 0x10)
    crypto_test_data = header[0x1C:0x2C]
    crypto_key = header[0x2C:0x3C]
    audio_hash = ""
    declared_ext = ""
    if crypto_version == 5:
        pos = 0x44
        if pos + 4 > len(header):
            raise DecodeError("kgg header missing audio hash length")
        audio_hash_len = struct.unpack_from("<I", header, pos)[0]
        pos += 4
        if audio_hash_len <= 0 or pos + audio_hash_len > len(header):
            raise DecodeError("invalid kgg audio hash length")
        audio_hash = header[pos:pos + audio_hash_len].decode("ascii", "ignore")
    return KugouHeader(
        magic_header=magic, audio_offset=audio_offset, crypto_version=crypto_version,
        crypto_slot=crypto_slot, crypto_test_data=crypto_test_data, crypto_key=crypto_key,
        audio_hash=audio_hash, declared_extension=declared_ext,
    )

def parse_header_file(path: pathlib.Path) -> KugouHeader:
    with path.open("rb") as fp:
        return parse_header_bytes(fp.read(HEADER_LEN))

def _decode_v3_stream(
    src: BinaryIO, dst: BinaryIO, own_key: bytes, pub_key: bytes,
    *, chunk_size: int = V3_STREAM_CHUNK_SIZE, compute_hash: bool = False, use_native: bool = True,
) -> dict:
    pos = 0
    sha256 = hashlib.sha256() if compute_hash else None
    head = bytearray()
    decoded_bytes = 0
    chunk_count = 0
    native_chunk_count = 0
    native_fallback_chunks = 0
    native_fallback_reason = None
    buffer = bytearray(chunk_size)
    view = memoryview(buffer)
    while True:
        read_len = src.readinto(buffer)
        if not read_len:
            break
        chunk_count += 1
        used_native, fallback_reason = _decode_v3_chunk(buffer, own_key, pub_key, pos, read_len, use_native=use_native)
        if used_native:
            native_chunk_count += 1
        elif fallback_reason is not None:
            native_fallback_chunks += 1
            if native_fallback_reason is None:
                native_fallback_reason = fallback_reason
        chunk = view[:read_len]
        if len(head) < 8192:
            head.extend(chunk[: 8192 - len(head)])
        dst.write(chunk)
        if sha256 is not None:
            sha256.update(chunk)
        decoded_bytes += read_len
        pos += read_len
    result = {
        "decoded_bytes": decoded_bytes,
        "head_hex": bytes(head[:64]).hex(),
        "detected_container": detect_extension(bytes(head), "bin"),
        "chunk_count": chunk_count,
        "native_chunk_count": native_chunk_count,
        "native_fallback_chunks": native_fallback_chunks,
        "native_fallback_reason": native_fallback_reason,
        "bytes_per_chunk_avg": round(decoded_bytes / chunk_count, 2) if chunk_count else 0.0,
    }
    if sha256 is not None:
        result["sha256"] = sha256.hexdigest()
    return result

def _decode_v5_stream(
    src: BinaryIO, dst: BinaryIO, cipher: StreamCipher,
    *, chunk_size: int = V5_STREAM_CHUNK_SIZE, compute_hash: bool = False,
) -> dict:
    pos = 0
    sha256 = hashlib.sha256() if compute_hash else None
    head = bytearray()
    decoded_bytes = 0
    buffer = bytearray(chunk_size)
    while True:
        read_len = src.readinto(buffer)
        if not read_len:
            break
        chunk = buffer[:read_len]
        cipher.decrypt(chunk, pos)
        if len(head) < 8192:
            head.extend(chunk[: 8192 - len(head)])
        dst.write(chunk)
        if sha256 is not None:
            sha256.update(chunk)
        decoded_bytes += read_len
        pos += read_len
    result = {
        "decoded_bytes": decoded_bytes,
        "head_hex": bytes(head[:64]).hex(),
        "detected_container": detect_extension(bytes(head), "bin"),
    }
    if sha256 is not None:
        result["sha256"] = sha256.hexdigest()
    return result

__all__ = [
    "detect_extension",
    "parse_header_bytes",
    "parse_header_file",
    "load_kgg_key_mapping",
    "_decode_v3_stream",
    "_decode_v5_stream",
    "_decode_v3_chunk",
    "_build_own_transform_tables",
    "_build_pub_transform_tables",
    "_build_v3_block_phase_tables",
    "_build_v3_numpy_lut",
    "_decrypt_database",
    "_extract_key_mapping",
    "_load_kgg_key_mapping_cached",
    "_derive_iv_seed",
    "_derive_page_iv",
    "_derive_page_key",
    "_validate_first_page_header",
]
