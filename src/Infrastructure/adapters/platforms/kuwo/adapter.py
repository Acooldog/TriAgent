from __future__ import annotations

import pathlib
import time
from dataclasses import dataclass

from src.Infrastructure.adapters.media.transcode.transcoder import detect_audio_container
from src.Infrastructure.adapters.platforms.kuwo.unlockmusic_decoder import decrypt_kwm_file, is_kwm_file, MAGIC_HEADER_1


SUPPORTED_SUFFIXES = {".kwm"}


@dataclass(slots=True)
class KuwoPlatformAdapter:
    platform_id: str = "kuwo"
    display_name: str = "酷我音乐"

    def requires_running_process(self) -> bool:
        return False

    def validate_runtime(self, settings: dict) -> tuple[bool, str | None]:
        return True, None

    def collect_files(self, input_path: pathlib.Path, recursive: bool) -> list[pathlib.Path]:
        if input_path.is_file():
            return [input_path] if input_path.suffix.lower() in SUPPORTED_SUFFIXES else []
        pattern = "**/*" if recursive else "*"
        return sorted(
            candidate
            for candidate in input_path.glob(pattern)
            if candidate.is_file() and candidate.suffix.lower() in SUPPORTED_SUFFIXES
        )

    def output_basename(self, input_path: pathlib.Path) -> str:
        return input_path.stem

    def predicted_extension(self, input_path: pathlib.Path, settings: dict) -> str | None:
        return None  # unlockmusic_decoder 自动探测

    def desired_target_format(self, input_path: pathlib.Path, settings: dict) -> str:
        value = str(settings.get("format_kwm", "auto") or "auto").strip().lower().lstrip(".") or "auto"
        return "m4a" if value == "ogg" else value

    def decrypt_one(self, input_path: pathlib.Path, work_dir: pathlib.Path, settings: dict, *, log_dir: pathlib.Path) -> dict:
        started = time.perf_counter()

        # 先校验魔数
        try:
            head = input_path.read_bytes()[:len(MAGIC_HEADER_1)]
            if not is_kwm_file(head):
                raise ValueError("not a valid kwm file (magic header mismatch)")
        except OSError as exc:
            raise RuntimeError(f"cannot read input file: {exc}") from exc

        output_hint = work_dir / input_path.stem
        final_path, ext = decrypt_kwm_file(input_path, output_hint)
        detected_container, recognition_stage = detect_audio_container(final_path)
        elapsed = round(time.perf_counter() - started, 6)
        return {
            "output_path": str(final_path),
            "detected_container": detected_container,
            "final_extension": ext,
            "recognition_stage": recognition_stage,
            "backend": "python:unlockmusic-kwm",
            "decoded_bytes": final_path.stat().st_size if final_path.exists() else 0,
            "timing": {
                "header_parse_sec": 0.0,
                "key_material_sec": 0.0,
                "stream_decode_sec": elapsed,
                "publish_sec": 0.0,
                "total_sec": elapsed,
            },
        }
