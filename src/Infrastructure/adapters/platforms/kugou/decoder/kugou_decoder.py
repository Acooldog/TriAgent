from __future__ import annotations
import os
import pathlib
import time
from src.Infrastructure.adapters.platforms.kugou.crypto.kugou_ciphers import (
    DEFAULT_KGG_DB_PATH,
    DEFAULT_KEY_PATH,
    DEFAULT_OUTPUT_DIR,
    DecodeError,
    HEADER_LEN,
    KGM_MAGIC,
    KugouHeader,
    OUTPUT_AUDIO_EXTENSIONS,
    OWN_KEY_LEN,
    PATHS,
    SUPPORTED_SUFFIXES,
    UnrecognizedAudioContainerError,
    V3_STREAM_CHUNK_SIZE,
    V5_STREAM_CHUNK_SIZE,
    VPR_MAGIC,
    _AES_CBC,
    _AesCbcNoPadding,
    _decrypt_tencent_tea,
    _derive_key,
    _derive_key_v1,
    _derive_key_v2,
    _new_qmc_cipher_from_ekey,
    _rotate_byte,
    _simple_make_key,
    _tea_decrypt_block,
    _xor8,
)
from src.Infrastructure.adapters.platforms.kugou.decoder.kugou_stream import (
    detect_extension,
    load_kgg_key_mapping,
    parse_header_bytes,
    parse_header_file,
    _build_own_transform_tables,
    _build_pub_transform_tables,
    _build_v3_block_phase_tables,
    _build_v3_numpy_lut,
    _decode_v3_chunk,
    _decode_v3_stream,
    _decode_v5_stream,
)
from src.Infrastructure.adapters.runtime.native_backend import get_native_backend
from src.Infrastructure.adapters.media.transcode.transcoder import probe_audio_container
from src.Infrastructure.adapters.platforms.kugou.crypto.kugou_ciphers import load_public_key
from src.Infrastructure.adapters.platforms.kugou.decoder.kugou_decoder_cli import build_parser, main

def output_basename(input_path: pathlib.Path) -> str:
    name = input_path.name
    lower_name = name.lower()
    for suffix in sorted(SUPPORTED_SUFFIXES, key=len, reverse=True):
        if lower_name.endswith(suffix):
            return name[: -len(suffix)]
    return input_path.stem

def ensure_output_path(input_path: pathlib.Path, output_dir: pathlib.Path, extension: str) -> pathlib.Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    return output_dir / f"{output_basename(input_path)}.{extension}"

def create_temp_output_path(input_path: pathlib.Path, output_dir: pathlib.Path) -> pathlib.Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    stamp = f"{time.time_ns()}_{os.getpid()}"
    return output_dir / f".{output_basename(input_path)}.{stamp}.tmp"

def create_failed_raw_output_path(input_path: pathlib.Path, failed_raw_dir: pathlib.Path, attempt: str) -> pathlib.Path:
    failed_raw_dir.mkdir(parents=True, exist_ok=True)
    stamp = f"{time.time_ns()}_{os.getpid()}_{attempt}"
    return failed_raw_dir / f"{output_basename(input_path)}.{stamp}.bin"

def cleanup_stale_bin(input_path: pathlib.Path, output_dir: pathlib.Path, final_ext: str) -> None:
    if final_ext == "bin":
        return
    stale_bin = output_dir / f"{output_basename(input_path)}.bin"
    if stale_bin.exists() and stale_bin.is_file():
        try:
            stale_bin.unlink()
        except OSError:
            pass

def decode_file(
    input_path: pathlib.Path,
    output_dir: pathlib.Path,
    *,
    key_path: pathlib.Path = DEFAULT_KEY_PATH,
    kgg_db_path: pathlib.Path = DEFAULT_KGG_DB_PATH,
    failed_raw_dir: pathlib.Path | None = None,
    publish_unrecognized_to_output: bool = True,
    attempt: str = "initial",
    force_python_v3: bool = False,
    force_python_v5: bool = False,
    attempt_count: int = 0,
    max_attempts: int = 3,
) -> dict:
    started_perf = time.perf_counter()
    native_backend = get_native_backend()
    timing = {
        "header_parse_sec": 0.0,
        "key_material_sec": 0.0,
        "stream_decode_sec": 0.0,
        "publish_sec": 0.0,
        "total_sec": 0.0,
    }
    input_path = input_path.expanduser().resolve()
    output_dir = output_dir.expanduser().resolve()
    key_path = key_path.expanduser().resolve()
    kgg_db_path = kgg_db_path.expanduser().resolve() if str(kgg_db_path) else kgg_db_path
    header_started = time.perf_counter()
    header = parse_header_file(input_path)
    timing["header_parse_sec"] = round(time.perf_counter() - header_started, 6)
    temp_output = create_temp_output_path(input_path, output_dir)
    try:
        if header.crypto_version == 5:
            key_started = time.perf_counter()
            if not kgg_db_path or not kgg_db_path.exists():
                raise DecodeError(f"missing KGMusicV3.db: {kgg_db_path}")
            mapping = load_kgg_key_mapping(kgg_db_path)
            ekey = mapping.get(header.audio_hash)
            if not ekey:
                raise DecodeError(f"ekey missing for audio_hash={header.audio_hash}")
            cipher = _new_qmc_cipher_from_ekey(ekey, use_native=not force_python_v5)
            timing["key_material_sec"] = round(time.perf_counter() - key_started, 6)
            decode_started = time.perf_counter()
            with input_path.open("rb", buffering=V5_STREAM_CHUNK_SIZE) as src, temp_output.open("wb", buffering=V5_STREAM_CHUNK_SIZE) as dst:
                src.seek(header.audio_offset)
                summary = _decode_v5_stream(src, dst, cipher, chunk_size=V5_STREAM_CHUNK_SIZE, compute_hash=False)
            timing["stream_decode_sec"] = round(time.perf_counter() - decode_started, 6)
            summary["audio_hash"] = header.audio_hash
            summary["declared_extension"] = header.declared_extension
            summary["crypto_mode"] = "v5"
            summary["kgg_db_path"] = str(kgg_db_path)
        else:
            key_started = time.perf_counter()
            pub_key = load_public_key(key_path)
            own_key = bytearray(OWN_KEY_LEN)
            own_key[:16] = header.crypto_test_data
            timing["key_material_sec"] = round(time.perf_counter() - key_started, 6)
            decode_started = time.perf_counter()
            with input_path.open("rb", buffering=V3_STREAM_CHUNK_SIZE) as src, temp_output.open("wb", buffering=V3_STREAM_CHUNK_SIZE) as dst:
                src.seek(header.audio_offset)
                summary = _decode_v3_stream(
                    src, dst, bytes(own_key), pub_key,
                    chunk_size=V3_STREAM_CHUNK_SIZE, compute_hash=False,
                    use_native=not force_python_v3,
                )
            timing["stream_decode_sec"] = round(time.perf_counter() - decode_started, 6)
            summary["own_key_hex"] = bytes(own_key).hex()
            summary["crypto_mode"] = "v3"
            summary["key_path"] = str(key_path)
        publish_started = time.perf_counter()
        fast_container = str(summary.get("detected_container", "bin")).strip().lower() or "bin"
        probed_container = None
        if fast_container == "bin":
            probed_container = probe_audio_container(temp_output)
        detected_container = probed_container or fast_container
        final_ext = detected_container
        if (
            final_ext == "bin" and header.crypto_version != 5 and not force_python_v3
            and native_backend.available and attempt_count < max_attempts
        ):
            return decode_file(
                input_path, output_dir, key_path=key_path, kgg_db_path=kgg_db_path,
                failed_raw_dir=failed_raw_dir, publish_unrecognized_to_output=publish_unrecognized_to_output,
                attempt="python_retry", force_python_v3=True, force_python_v5=force_python_v5,
                attempt_count=attempt_count + 1, max_attempts=max_attempts,
            )
        if (
            final_ext == "bin" and header.crypto_version == 5 and not force_python_v5
            and native_backend.available and attempt_count < max_attempts
        ):
            return decode_file(
                input_path, output_dir, key_path=key_path, kgg_db_path=kgg_db_path,
                failed_raw_dir=failed_raw_dir, publish_unrecognized_to_output=publish_unrecognized_to_output,
                attempt="python_retry", force_python_v3=force_python_v3, force_python_v5=True,
                attempt_count=attempt_count + 1, max_attempts=max_attempts,
            )
        if final_ext == "bin" and not publish_unrecognized_to_output:
            failed_raw_path = None
            if failed_raw_dir is not None:
                failed_raw_path = create_failed_raw_output_path(input_path, failed_raw_dir, attempt)
                if failed_raw_path.exists():
                    failed_raw_path.unlink()
                temp_output.replace(failed_raw_path)
            timing["publish_sec"] = round(time.perf_counter() - publish_started, 6)
            timing["total_sec"] = round(time.perf_counter() - started_perf, 6)
            summary.update({
                "input_path": str(input_path),
                "output_path": None,
                "failed_raw_path": str(failed_raw_path) if failed_raw_path is not None else None,
                "magic_header_hex": header.magic_header.hex(),
                "audio_offset": header.audio_offset,
                "crypto_version": header.crypto_version,
                "crypto_slot": header.crypto_slot,
                "crypto_test_data_hex": header.crypto_test_data.hex(),
                "crypto_key_hex": header.crypto_key.hex(),
                "detected_container": detected_container,
                "final_extension": None,
                "recognition_stage": "fast_probe_failed",
                "backend": "python-forced" if force_python_v3 or force_python_v5 else (
                    f"native-c:{native_backend.dll_path.name}" if native_backend.available and native_backend.dll_path else "python"
                ),
                "timing": timing,
            })
            raise UnrecognizedAudioContainerError(summary)
        final_output = ensure_output_path(input_path, output_dir, final_ext)
        if final_output.exists():
            final_output.unlink()
        temp_output.replace(final_output)
        cleanup_stale_bin(input_path, output_dir, final_ext)
        timing["publish_sec"] = round(time.perf_counter() - publish_started, 6)
        timing["total_sec"] = round(time.perf_counter() - started_perf, 6)
        summary.update({
            "input_path": str(input_path),
            "output_path": str(final_output),
            "magic_header_hex": header.magic_header.hex(),
            "audio_offset": header.audio_offset,
            "crypto_version": header.crypto_version,
            "crypto_slot": header.crypto_slot,
            "crypto_test_data_hex": header.crypto_test_data.hex(),
            "crypto_key_hex": header.crypto_key.hex(),
            "detected_container": detected_container,
            "final_extension": final_ext,
            "recognition_stage": "fast" if detected_container == fast_container else "ffmpeg_probe",
            "backend": "python-forced" if force_python_v3 or force_python_v5 else (
                f"native-c:{native_backend.dll_path.name}" if native_backend.available and native_backend.dll_path else "python"
            ),
            "timing": timing,
        })
        return summary
    finally:
        if temp_output.exists():
            try:
                temp_output.unlink()
            except OSError:
                pass

__all__ = [
    "PATHS", "DEFAULT_KEY_PATH", "DEFAULT_OUTPUT_DIR", "DEFAULT_KGG_DB_PATH",
    "HEADER_LEN", "KGM_MAGIC", "VPR_MAGIC", "SUPPORTED_SUFFIXES",
    "OUTPUT_AUDIO_EXTENSIONS", "V3_STREAM_CHUNK_SIZE", "V5_STREAM_CHUNK_SIZE",
    "OWN_KEY_LEN", "DecodeError", "UnrecognizedAudioContainerError", "KugouHeader",
    "_AES_CBC", "_AesCbcNoPadding",
    "detect_extension", "output_basename", "ensure_output_path",
    "create_temp_output_path", "create_failed_raw_output_path", "cleanup_stale_bin",
    "decode_file", "load_public_key", "load_kgg_key_mapping",
    "parse_header_bytes", "parse_header_file",
    "build_parser", "main",
]
