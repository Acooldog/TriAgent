from __future__ import annotations
import hashlib
import logging
import os
import shutil
import time
import frida

logger = logging.getLogger("qqmusic_decrypt.manager")

def Decryptor_main(input_dir="", output_dir="", del_original=False):
    from src.Infrastructure.adapters.platforms.qq.runtime.decrypt.qq_decryptor import QQMusicDecryptor, pick_safe_tmp_dir
    start_time = time.perf_counter()
    logger.info("输入目录: %s", input_dir)
    logger.info("输出目录: %s", output_dir)
    logger.info("删除原文件: %s", del_original)
    logger.info("Frida version: %s", frida.__version__)
    device_manager = frida.get_device_manager()
    device = device_manager.get_local_device()
    logger.info("Device name: %s", device.name)
    try:
        processes = device.enumerate_processes()
        qq_music_process = next(
            (p for p in processes if "qqmusic" in p.name.lower()), None
        )
        if not qq_music_process:
            raise RuntimeError("请先启动QQ音乐")
        logger.info("找到QQ音乐进程: PID=%s", qq_music_process.pid)
    except Exception as e:
        raise RuntimeError(f"查找QQ音乐进程失败: {e}")
    session = device.attach(qq_music_process.pid)
    try:
        decryptor = QQMusicDecryptor(session)
    except Exception:
        logger.exception("初始化解密器失败")
        return
    qq_music_dir = input_dir
    if not os.path.exists(qq_music_dir):
        raise RuntimeError(f"QQ音乐下载目录不存在: {qq_music_dir}")
    logger.info("QQ音乐目录: %s", qq_music_dir)
    output_dir_path = output_dir
    if not os.path.exists(output_dir_path):
        os.makedirs(output_dir_path)
    logger.info("输出目录: %s", output_dir_path)
    tmp_base_dir = pick_safe_tmp_dir(output_dir_path)
    if tmp_base_dir != output_dir_path:
        logger.info("使用临时目录写入: %s", tmp_base_dir)
    processed_count = 0
    skipped_count = 0
    failed_count = 0
    for entry in os.listdir(qq_music_dir):
        file_path = os.path.join(qq_music_dir, entry)
        if not os.path.isfile(file_path):
            continue
        _, ext = os.path.splitext(entry)
        if ext.lower() not in [".mflac", ".mgg"]:
            continue
        new_ext = "flac" if ext.lower() == ".mflac" else "ogg"
        base_name = os.path.splitext(entry)[0]
        new_file_name = base_name + "." + new_ext
        new_file_path = os.path.join(output_dir_path, new_file_name)
        logger.info("开始处理文件: %s -> %s", file_path, new_file_path)
        if os.path.exists(new_file_path):
            logger.info("文件已存在，跳过处理: %s", new_file_path)
            if del_original:
                try:
                    os.remove(file_path)
                    logger.info("已删除原文件: %s", file_path)
                except Exception as e:
                    logger.warning("删除原文件失败: %s, %s", file_path, e)
            skipped_count += 1
            continue
        md5_hash = hashlib.md5(new_file_name.encode()).hexdigest()
        tmp_file_path = os.path.join(tmp_base_dir, md5_hash)
        try:
            success = decryptor.decrypt(file_path, tmp_file_path)
            if success:
                try:
                    shutil.move(tmp_file_path, new_file_path)
                    logger.info("处理文件完成: %s", new_file_path)
                except Exception as e:
                    logger.error("移动临时文件失败: %s -> %s, %s", tmp_file_path, new_file_path, e)
                    if os.path.exists(tmp_file_path):
                        os.remove(tmp_file_path)
                    failed_count += 1
                    continue
                if del_original:
                    try:
                        os.remove(file_path)
                        logger.info("已删除原文件: %s", file_path)
                    except Exception as e:
                        logger.warning("删除原文件失败: %s, %s", file_path, e)
                processed_count += 1
            else:
                logger.error("解密失败: %s", file_path)
                failed_count += 1
                if os.path.exists(tmp_file_path):
                    os.remove(tmp_file_path)
        except Exception as e:
            logger.exception("处理文件失败: %s, %s", file_path, e)
            failed_count += 1
            if os.path.exists(tmp_file_path):
                os.remove(tmp_file_path)
    elapsed = time.perf_counter() - start_time
    logger.info(
        "处理完成！成功: %s, 跳过: %s, 失败: %s, 耗时: %.2f 秒",
        processed_count, skipped_count, failed_count, elapsed,
    )
    return (
        True,
        f"成功处理 {processed_count} 个文件，跳过 {skipped_count} 个文件，失败 {failed_count} 个文件",
    )

__all__ = ["Decryptor_main"]
