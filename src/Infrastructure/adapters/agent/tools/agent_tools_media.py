from __future__ import annotations

from src.Infrastructure.adapters.agent.tools.agent_tools_state import _to_path, tool


@tool
def transcode_audio(input_path: str, target_format: str, output_dir: str = "") -> str:
    """将音频文件用 ffmpeg 转换为目标格式（mp3/m4a/flac/wav）。输入可以是单个文件或目录，会原地替换或输出到指定目录。

    Args:
        input_path: 源音频文件或目录路径
        target_format: 目标格式，可选 mp3/m4a/flac/wav
        output_dir: 可选输出目录，留空则输出到源文件同目录
    """
    try:
        from src.Infrastructure.adapters.media.transcode.transcoder import (
            SUPPORTED_TARGET_FORMATS,
            normalize_target_format,
            transcode_file,
        )

        src = _to_path(input_path)
        if not src.exists():
            return f"错误：输入路径不存在 - {input_path}"

        fmt = normalize_target_format(target_format)
        if fmt == "auto":
            return "错误：目标格式必须明确指定（mp3/m4a/flac/wav），不接受 auto。"

        dst_root = _to_path(output_dir) if output_dir.strip() else (src.parent if src.is_file() else src)
        dst_root.mkdir(parents=True, exist_ok=True)
        print(f"[transcode_audio] 输入: {src} | 目标格式: {fmt} | 输出: {dst_root}")

        files = [src] if src.is_file() else sorted(p for p in src.rglob("*") if p.is_file())
        audio_exts = {".flac", ".mp3", ".m4a", ".wav", ".ogg", ".aac"}
        targets = [p for p in files if p.suffix.lower() in audio_exts]
        if not targets:
            return f"未找到可转换的音频文件（支持 flac/mp3/m4a/wav/ogg/aac）"
        print(f"[transcode_audio] 待转换文件 {len(targets)} 个")

        results: list[str] = []
        success = 0
        failed = 0
        skipped = 0
        for file_path in targets:
            out_name = f"{file_path.stem}.{fmt}"
            # 目录输入时若指定了 output_dir 则统一写到 dst_root，否则写回源文件所在目录
            out_dir = dst_root if (output_dir.strip() or src.is_file()) else file_path.parent
            out_path = out_dir / out_name
            if out_path == file_path:
                results.append(f"  跳过: {file_path.name} - 目标格式与原文件相同，不覆盖原文件")
                skipped += 1
                print(f"[transcode_audio] 跳过: {file_path.name} - 同扩展名")
                continue
            if out_path.exists():
                out_path = out_path.with_name(f"{file_path.stem}_converted.{fmt}")
                print(f"[transcode_audio] 重命名以避免覆盖: {out_path.name}")
            print(f"[transcode_audio] 开始: {file_path.name} -> {fmt}")
            try:
                info = transcode_file(file_path, out_path, fmt)
                results.append(f"  成功: {file_path.name} -> {info.get('output_path', out_path)}")
                success += 1
            except Exception as exc:
                results.append(f"  失败: {file_path.name} - {exc}")
                failed += 1
                print(f"[transcode_audio] 失败: {file_path.name} - {exc}")

        header = f"转换完成：共 {len(targets)} 个文件，成功 {success}，失败 {failed}，跳过 {skipped}"
        print(f"[transcode_audio] {header}")
        return header + "\n" + "\n".join(results)
    except ValueError as exc:
        return f"错误：{exc}"
    except FileNotFoundError as exc:
        return f"错误：{exc}"
    except Exception as exc:
        return f"转换失败：{exc}"


@tool
def verify_audio_integrity(input_path: str) -> str:
    """校验音频文件是否完整可播放。通过容器探测、流信息分析判断文件是否损坏。完成解密或格式转换后应调用本工具确认结果。

    Args:
        input_path: 单个音频文件路径或包含音频文件的目录
    """
    try:
        from src.Infrastructure.adapters.media.transcode.transcoder import detect_audio_container, probe_media_summary, summary_to_log

        src = _to_path(input_path)
        if not src.exists():
            return f"错误：输入路径不存在 - {input_path}"

        files = [src] if src.is_file() else sorted(p for p in src.rglob("*") if p.is_file())
        audio_exts = {".flac", ".mp3", ".m4a", ".wav", ".ogg", ".aac", ".bin"}
        targets = [p for p in files if p.suffix.lower() in audio_exts]
        if not targets:
            return f"未发现音频文件（支持 flac/mp3/m4a/wav/ogg/aac）"

        print(f"[verify_audio_integrity] 待校验 {len(targets)} 个文件")
        results: list[str] = []
        ok_count = 0
        broken_count = 0
        for file_path in targets:
            try:
                container, stage = detect_audio_container(file_path)
                summary = probe_media_summary(file_path)
                audio_streams = int(summary.get("audio_streams", 0) or 0)
                size = file_path.stat().st_size
                if container == "bin" or audio_streams < 1 or size < 1024:
                    results.append(f"  损坏: {file_path.name} - container={container} audio_streams={audio_streams} size={size}")
                    broken_count += 1
                    print(f"[verify_audio_integrity] 损坏: {file_path.name}")
                else:
                    results.append(f"  正常: {file_path.name} - {summary_to_log(summary)}")
                    ok_count += 1
                    print(f"[verify_audio_integrity] 正常: {file_path.name} [{container}]")
            except Exception as exc:
                results.append(f"  损坏: {file_path.name} - {exc}")
                broken_count += 1
                print(f"[verify_audio_integrity] 异常: {file_path.name} - {exc}")

        header = f"校验完成：共 {len(targets)} 个文件，正常 {ok_count}，损坏 {broken_count}"
        print(f"[verify_audio_integrity] {header}")
        return header + "\n" + "\n".join(results)
    except Exception as exc:
        return f"校验失败：{exc}"


@tool
def rag_retrieve(query: str, top_k: int = 4) -> str:
    """在本地知识库检索与问题相关的已沉淀解决方案/经验。

    Args:
        query: 要检索的问题或关键词（自然语言即可）
        top_k: 返回的最相关条目数，默认 4
    """
    try:
        from src.Infrastructure.adapters.rag.seed import ensure_seeded
        from src.Infrastructure.adapters.rag.store import query_similar

        ensure_seeded()
        hits = query_similar(query, top_k=max(1, int(top_k)))
        if not hits:
            return "知识库为空，暂无相关记录。"
        lines = [f"检索到 {len(hits)} 条相关知识："]
        for idx, h in enumerate(hits, 1):
            score = round(float(h.get("score", 0.0)), 3)
            source = h.get("source") or "未知"
            text = str(h.get("text", "")).strip()
            lines.append(f"\n[{idx}] (相关度 {score}) 来源: {source}\n{text}")
        print(f"[rag_retrieve] query={query[:60]} -> {len(hits)} 条")
        return "\n".join(lines)
    except Exception as exc:
        return f"知识库检索失败：{exc}"


@tool
def rag_ingest(text: str, source: str = "agent") -> str:
    """把一条经验/解决方案写入本地知识库，便于后续检索复用。

    Args:
        text: 要沉淀的知识内容（自然语言描述的方案/经验）
        source: 来源标识，如 "agent"、"用户补充"、"调试经验"
    """
    try:
        from src.Infrastructure.adapters.rag.store import upsert_document

        if not text.strip():
            return "错误：内容不能为空"
        doc_id = upsert_document(text=text.strip(), source=source or "agent")
        print(f"[rag_ingest] 写入 id={doc_id} source={source} len={len(text)}")
        return f"已写入知识库: id={doc_id} 来源={source}"
    except Exception as exc:
        return f"知识库写入失败：{exc}"


__all__ = [
    "transcode_audio",
    "verify_audio_integrity",
    "rag_retrieve",
    "rag_ingest",
]
