from __future__ import annotations
import argparse
import json
import pathlib
from typing import List, Optional
from src.Infrastructure.kugou_ciphers import DEFAULT_KEY_PATH, DEFAULT_OUTPUT_DIR, DEFAULT_KGG_DB_PATH

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Offline decoder for KuGou kgma/kgm/kgg/vpr files.")
    parser.add_argument("--input", required=True, help="Path to Kugou encrypted file")
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR), help="Output directory")
    parser.add_argument("--key-file", default=str(DEFAULT_KEY_PATH), help="Path to kugou_key.xz for v3 files")
    parser.add_argument("--kgg-db", default=str(DEFAULT_KGG_DB_PATH), help="Path to KGMusicV3.db for kgg files")
    parser.add_argument("--json", action="store_true", help="Print JSON summary")
    return parser

def main(argv: Optional[List[str]] = None) -> int:
    from src.Infrastructure.kugou_decoder import decode_file
    args = build_parser().parse_args(argv)
    summary = decode_file(
        pathlib.Path(args.input),
        pathlib.Path(args.output_dir),
        key_path=pathlib.Path(args.key_file),
        kgg_db_path=pathlib.Path(args.kgg_db),
    )
    if args.json:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    else:
        for key in (
            "input_path", "output_path", "detected_container", "final_extension",
            "decoded_bytes", "sha256", "crypto_mode", "audio_hash",
            "declared_extension", "head_hex",
        ):
            value = summary.get(key)
            if value:
                print(f"{key}={value}")
    return 0

__all__ = ["build_parser", "main"]
