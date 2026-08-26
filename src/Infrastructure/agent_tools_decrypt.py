from __future__ import annotations
import os
import pathlib
from src.Infrastructure.agent_tools_state import (
    _find_kgg_db,
    _find_kugou_key,
    _to_path,
    tool,
)
from src.Infrastructure.file_catalog import iter_supported_files
from src.Infrastructure.kugou_decoder import decode_file
from src.Infrastructure.processed_index import (
    INDEX_FILENAME,
    mark_processed,
    plan_files,
    save_index,
)
@tool
def scan_files(directory: str, recursive: bool = True, file_types: str = "kugou") -> str:
    """扫描指定目录下的加密音乐文件。
    Args: directory: 要扫描的目录路径, recursive: 是否递归扫描子目录，默认为 True, file_types: 文件类型过滤，支持 "kugou"（酷狗格式）与 "qq"（QQ音乐格式）
    """
    try:
        input_path = _to_path(directory)
        if not input_path.exists():
            return f"错误：目录不存在 - {directory}"
        if not input_path.is_dir():
            return f"错误：路径不是目录 - {directory}"
        files = iter_supported_files(input_path, recursive)
        if not files:
            return f"在 {directory} 中未找到加密音乐文件"
        by_type: dict[str, list[str]] = {}
        for f in files:
            ext = f.suffix.lower()
            if ext not in by_type:
                by_type[ext] = []
            by_type[ext].append(str(f))
        parts = [f"在 {directory} 中找到 {len(files)} 个加密文件:"]
        for ext, paths in sorted(by_type.items()):
            parts.append(f"\n  {ext}: {len(paths)} 个")
            for p in paths[:10]:
                parts.append(f"    - {p}")
            if len(paths) > 10:
                parts.append(f"    ... 还有 {len(paths) - 10} 个")
        return "\n".join(parts)
    except Exception as exc:
        return f"扫描失败：{exc}"
@tool
def decrypt_kugou(input_path: str, output_dir: str, target_format: str = "auto") -> str:
    """解密酷狗音乐加密文件（kgma/kgm/kgg/vpr），输出为可播放的音频文件。
    Args: input_path: 加密文件或包含加密文件的目录路径, output_dir: 解密后音频文件的输出目录, target_format: 输出格式，可选 "auto"、"flac"、"m4a"、"mp3"、"wav"
    """
    try:
        src = _to_path(input_path)
        dst = _to_path(output_dir)
        dst.mkdir(parents=True, exist_ok=True)
        if not src.exists():
            return f"错误：输入路径不存在 - {input_path}"
        key_file = _find_kugou_key()
        if key_file is None:
            return "错误：未找到 kugou_key.xz 公钥文件，请确保 assets 目录下存在该文件"
        if src.is_file():
            files_to_decrypt = [src]
        else:
            files_to_decrypt = iter_supported_files(src, True)
        if not files_to_decrypt:
            return f"在 {input_path} 中未找到酷狗加密文件"
        pending, skipped = plan_files(files_to_decrypt)
        if skipped:
            print(f"[decrypt_kugou] 跳过已处理文件 {len(skipped)} 个（见 {INDEX_FILENAME}）")
        if not pending:
            return f"所有 {len(skipped)} 个文件均已处理过（见 {INDEX_FILENAME}），本次跳过。"
        results = []
        success = 0
        failed = 0
        for item in pending:
            file_path = item["file"]
            index = item["index"]
            index_dir = item["index_dir"]
            index_path = item["index_path"]
            try:
                summary = decode_file(
                    file_path,
                    dst,
                    key_path=key_file,
                    kgg_db_path=_find_kgg_db() or pathlib.Path(),
                )
                out_path = summary.get("output_path", "")
                container = summary.get("detected_container", "bin")
                if out_path:
                    results.append(f"  成功: {file_path.name} -> {out_path} [{container}]")
                    success += 1
                    mark_processed(index, file_path, index_dir, str(out_path), container)
                    save_index(index_path, index)
                else:
                    results.append(f"  失败: {file_path.name} - 未识别的音频容器")
                    failed += 1
            except Exception as exc:
                results.append(f"  失败: {file_path.name} - {exc}")
                failed += 1
        header = f"解密完成：共 {len(pending)} 个待处理，成功 {success}，失败 {failed}，跳过 {len(skipped)}"
        return header + "\n" + "\n".join(results)
    except Exception as exc:
        return f"解密失败：{exc}"
@tool
def decrypt_qq(input_path: str, output_dir: str) -> str:
    """解密 QQ 音乐加密文件（mflac/mgg/mmp4），输出为可播放的音频文件。需要 QQ 音乐客户端已运行。
    Args: input_path: 加密文件或包含加密文件的目录路径, output_dir: 解密后音频文件的输出目录
    """
    try:
        src = _to_path(input_path)
        dst = _to_path(output_dir)
        dst.mkdir(parents=True, exist_ok=True)
        if not src.exists():
            return f"错误：输入路径不存在 - {input_path}"
        print(f"[decrypt_qq] 输入: {src} | 输出: {dst}")
        try:
            from src.Infrastructure.platforms.registry import build_platform_adapter
        except ImportError as exc:
            return f"错误：QQ 音乐解密运行时不可用 - {exc}"
        adapter = build_platform_adapter("qq")
        ok, _reason = adapter.validate_runtime({"process_match": "qqmusic", "auto_start": True})
        if not ok:
            return f"错误：{_reason or '未检测到运行中的 QQ 音乐客户端，自动启动也未成功。'}"
        print("[decrypt_qq] 运行时校验通过，QQ 音乐进程已就绪")
        files_to_decrypt = adapter.collect_files(src, True)
        if not files_to_decrypt:
            return f"在 {input_path} 中未找到 QQ 音乐加密文件（mflac/mgg/mmp4）"
        print(f"[decrypt_qq] 待解密文件 {len(files_to_decrypt)} 个")
        pending, skipped = plan_files(files_to_decrypt)
        if skipped:
            print(f"[decrypt_qq] 跳过已处理文件 {len(skipped)} 个（见 {INDEX_FILENAME}）")
        if not pending:
            return f"所有 {len(skipped)} 个文件均已处理过（见 {INDEX_FILENAME}），本次跳过。"
        results: list[str] = []
        success = 0
        failed = 0
        for item in pending:
            file_path = item["file"]
            index = item["index"]
            index_dir = item["index_dir"]
            index_path = item["index_path"]
            print(f"[decrypt_qq] 开始处理: {file_path.name}")
            try:
                summary = adapter.decrypt_one(
                    file_path,
                    dst,
                    {"format_rules": {"mflac": "flac", "mgg": "m4a", "mmp4": "m4a"}},
                    log_dir=dst,
                )
                out_path = summary.get("output_path", "")
                container = summary.get("detected_container", "bin")
                if out_path:
                    results.append(f"  成功: {file_path.name} -> {out_path} [{container}]")
                    success += 1
                    print(f"[decrypt_qq] 成功: {file_path.name} -> {container}")
                    mark_processed(index, file_path, index_dir, str(out_path), container)
                    save_index(index_path, index)
                else:
                    results.append(f"  失败: {file_path.name} - 未识别的音频容器")
                    failed += 1
            except Exception as exc:
                results.append(f"  失败: {file_path.name} - {exc}")
                failed += 1
                print(f"[decrypt_qq] 失败: {file_path.name} - {exc}")
        header = f"解密完成：共 {len(pending)} 个待处理，成功 {success}，失败 {failed}，跳过 {len(skipped)}"
        print(f"[decrypt_qq] {header}")
        return header + "\n" + "\n".join(results)
    except Exception as exc:
        return f"解密失败：{exc}"
@tool
def decrypt_netease(input_path: str, output_dir: str) -> str:
    """解密网易云音乐加密文件（ncm 格式），输出为可播放的音频文件。无需运行网易云音乐客户端。
    Args: input_path: 加密文件或包含加密文件的目录路径, output_dir: 解密后音频文件的输出目录
    """
    try:
        src = _to_path(input_path)
        dst = _to_path(output_dir)
        dst.mkdir(parents=True, exist_ok=True)
        if not src.exists():
            return f"错误：输入路径不存在 - {input_path}"
        print(f"[decrypt_netease] 输入: {src} | 输出: {dst}")
        try:
            from src.Infrastructure.platforms.registry import build_platform_adapter
        except ImportError as exc:
            return f"错误：网易云解密运行时不可用 - {exc}"
        adapter = build_platform_adapter("netease")
        ok, _reason = adapter.validate_runtime({})
        if not ok:
            return "错误：网易云解密运行时校验失败。"
        print("[decrypt_netease] 运行时校验通过")
        files_to_decrypt = adapter.collect_files(src, True)
        if not files_to_decrypt:
            return f"在 {input_path} 中未找到网易云音乐加密文件（ncm）"
        print(f"[decrypt_netease] 待解密文件 {len(files_to_decrypt)} 个")
        pending, skipped = plan_files(files_to_decrypt)
        if skipped:
            print(f"[decrypt_netease] 跳过已处理文件 {len(skipped)} 个（见 {INDEX_FILENAME}）")
        if not pending:
            return f"所有 {len(skipped)} 个文件均已处理过（见 {INDEX_FILENAME}），本次跳过。"
        results: list[str] = []
        success = 0
        failed = 0
        for item in pending:
            file_path = item["file"]
            index = item["index"]
            index_dir = item["index_dir"]
            index_path = item["index_path"]
            print(f"[decrypt_netease] 开始处理: {file_path.name}")
            try:
                summary = adapter.decrypt_one(file_path, dst, {}, log_dir=dst)
                out_path = summary.get("output_path", "")
                container = summary.get("detected_container", "bin")
                if out_path:
                    results.append(f"  成功: {file_path.name} -> {out_path} [{container}]")
                    success += 1
                    print(f"[decrypt_netease] 成功: {file_path.name} -> {container}")
                    mark_processed(index, file_path, index_dir, str(out_path), container)
                    save_index(index_path, index)
                else:
                    results.append(f"  失败: {file_path.name} - 未识别的音频容器")
                    failed += 1
            except Exception as exc:
                results.append(f"  失败: {file_path.name} - {exc}")
                failed += 1
                print(f"[decrypt_netease] 失败: {file_path.name} - {exc}")
        header = f"解密完成：共 {len(pending)} 个待处理，成功 {success}，失败 {failed}，跳过 {len(skipped)}"
        print(f"[decrypt_netease] {header}")
        return header + "\n" + "\n".join(results)
    except Exception as exc:
        return f"解密失败：{exc}"
@tool
def decrypt_kuwo(input_path: str, output_dir: str) -> str:
    """解密酷我音乐加密文件（kwm 格式），输出为可播放的音频文件。无需运行酷我音乐客户端。
    Args: input_path: 加密文件或包含加密文件的目录路径, output_dir: 解密后音频文件的输出目录
    """
    try:
        from src.Infrastructure.platforms.kuwo.unlockmusic_decoder import decrypt_kwm_file
        src = _to_path(input_path)
        dst = _to_path(output_dir)
        dst.mkdir(parents=True, exist_ok=True)
        if not src.exists():
            return f"错误：输入路径不存在 - {input_path}"
        print(f"[decrypt_kuwo] 输入: {src} | 输出: {dst}")
        KWM_SUFFIX = ".kwm"
        if src.is_file():
            files = [src] if src.suffix.lower() == KWM_SUFFIX else []
        else:
            files = sorted(p for p in src.rglob("*") if p.is_file() and p.suffix.lower() == KWM_SUFFIX)
        if not files:
            return f"在 {input_path} 中未找到酷我音乐加密文件（kwm）"
        print(f"[decrypt_kuwo] 待解密文件 {len(files)} 个")
        pending, skipped = plan_files(files)
        if skipped:
            print(f"[decrypt_kuwo] 跳过已处理文件 {len(skipped)} 个（见 {INDEX_FILENAME}）")
        if not pending:
            return f"所有 {len(skipped)} 个文件均已处理过（见 {INDEX_FILENAME}），本次跳过。"
        results: list[str] = []
        success = 0
        failed = 0
        for item in pending:
            file_path = item["file"]
            index = item["index"]
            index_dir = item["index_dir"]
            index_path = item["index_path"]
            print(f"[decrypt_kuwo] 开始处理: {file_path.name}")
            try:
                out_base = dst / file_path.stem
                final_path, ext = decrypt_kwm_file(file_path, out_base)
                results.append(f"  成功: {file_path.name} -> {final_path} [{ext}]")
                success += 1
                print(f"[decrypt_kuwo] 成功: {file_path.name} -> {ext}")
                mark_processed(index, file_path, index_dir, str(final_path), ext)
                save_index(index_path, index)
            except Exception as exc:
                results.append(f"  失败: {file_path.name} - {exc}")
                failed += 1
                print(f"[decrypt_kuwo] 失败: {file_path.name} - {exc}")
        header = f"解密完成：共 {len(pending)} 个待处理，成功 {success}，失败 {failed}，跳过 {len(skipped)}"
        print(f"[decrypt_kuwo] {header}")
        return header + "\n" + "\n".join(results)
    except Exception as exc:
        return f"解密失败：{exc}"
__all__ = [
    "scan_files",
    "decrypt_kugou",
    "decrypt_qq",
    "decrypt_netease",
    "decrypt_kuwo",
]
