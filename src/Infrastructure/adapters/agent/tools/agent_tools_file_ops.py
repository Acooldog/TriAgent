from __future__ import annotations
import os
import pathlib
import shutil
import traceback
from src.Infrastructure.adapters.agent.tools.agent_safety import detect_destructive_intent
from src.Infrastructure.adapters.agent.tools.agent_tools_state import (
    _ALLOWED_CLI_COMMANDS,
    _CliArgs,
    _DANGEROUS_CLI_COMMANDS,
    _get_ask_user_callback,
    _get_permission_mode,
    _to_path,
    tool,
)
from src.Infrastructure.adapters.platforms.kugou.decoder.kugou_decoder import detect_extension
from src.Infrastructure.adapters.runtime.soft_sandbox import get_sandbox


def _format_tool_error(exc: Exception, tool_name: str) -> str:
    """格式化工具异常，保留类型和简化堆栈给模型。"""
    tb = exc.__traceback__
    if tb is not None:
        tb_lines = traceback.format_exception(type(exc), exc, tb)
        short_tb = "".join(tb_lines[-3:]).strip() if len(tb_lines) > 3 else "".join(tb_lines).strip()
    else:
        short_tb = "(无堆栈信息)"
    return f"❌ {tool_name} 失败 [{type(exc).__name__}]: {exc}\n--- 堆栈 ---\n{short_tb}"
@tool
def copy_files(source_dir: str, target_dir: str, file_extensions: str = "") -> str:
    """将文件从源目录复制到目标目录（保留源文件），可选按扩展名过滤。
    Args: source_dir: 源目录路径, target_dir: 目标目录路径, file_extensions: 扩展名过滤，逗号分隔（如 ".flac,.m4a"），为空则复制所有文件
    """
    try:
        src = _to_path(source_dir)
        dst = _to_path(target_dir)
        dst.mkdir(parents=True, exist_ok=True)
        if not src.exists():
            return f"错误：源目录不存在 - {source_dir}"
        extensions = set()
        if file_extensions.strip():
            extensions = {ext.strip().lower() for ext in file_extensions.split(",")}
        count = 0
        for item in src.iterdir():
            if not item.is_file():
                continue
            if extensions and item.suffix.lower() not in extensions:
                continue
            target = dst / item.name
            if target.exists():
                target.unlink()
            shutil.copy2(str(item), str(target))
            count += 1
        return f"已复制 {count} 个文件从 {source_dir} 到 {target_dir}"
    except Exception as exc:
        return _format_tool_error(exc, "copy_files")
@tool
def move_files(source_dir: str, target_dir: str, file_extensions: str = "") -> str:
    """将文件从源目录移动到目标目录（不保留源文件），可选按扩展名过滤。
    Args: source_dir: 源目录路径, target_dir: 目标目录路径, file_extensions: 扩展名过滤，逗号分隔（如 ".flac,.ogg"），为空则移动所有文件
    """
    try:
        src = _to_path(source_dir)
        dst = _to_path(target_dir)
        dst.mkdir(parents=True, exist_ok=True)
        if not src.exists():
            return f"错误：源目录不存在 - {source_dir}"
        extensions = set()
        if file_extensions.strip():
            extensions = {ext.strip().lower() for ext in file_extensions.split(",")}
        count = 0
        for item in src.iterdir():
            if not item.is_file():
                continue
            if extensions and item.suffix.lower() not in extensions:
                continue
            target = dst / item.name
            if target.exists():
                target.unlink()
            shutil.move(str(item), str(target))
            count += 1
        ext_info = f"（扩展名过滤: {file_extensions}）" if file_extensions.strip() else "（所有文件）"
        return f"已移动 {count} 个文件从 {source_dir} 到 {target_dir}{ext_info}"
    except Exception as exc:
        return _format_tool_error(exc, "move_files")
@tool
def rename_file(file_path: str, new_name: str) -> str:
    """重命名单个文件，文件保持在原目录不变。
    Args: file_path: 源文件路径, new_name: 新文件名（不含目录路径，如 "新名字.mp3"）
    """
    try:
        src = _to_path(file_path)
        if not src.exists() or not src.is_file():
            return f"错误：源文件不存在或不是文件 - {file_path}"
        new_name_clean = pathlib.PurePath(new_name).name
        if not new_name_clean or new_name_clean in (".", ".."):
            return f"错误：新文件名无效 - {new_name}"
        target = src.parent / new_name_clean
        if target == src:
            return f"新文件名与原文件名相同，无需重命名 - {src.name}"
        if target.exists():
            return f"错误：目标文件已存在 - {target}"
        src.rename(target)
        print(f"[rename_file] {src.name} -> {target.name}")
        return f"已重命名: {src.name} -> {target}"
    except Exception as exc:
        return _format_tool_error(exc, "rename_file")
@tool
def list_directory(directory: str, show_hidden: bool = False) -> str:
    """列出指定目录下的所有文件和子目录。
    Args: directory: 目录路径, show_hidden: 是否显示隐藏文件，默认为 False
    """
    try:
        path = _to_path(directory)
        if not path.exists():
            return f"错误：目录不存在 - {directory}"
        if not path.is_dir():
            return f"错误：路径不是目录 - {directory}"
        entries = sorted(path.iterdir(), key=lambda x: (x.is_file(), x.name.lower()))
        if not show_hidden:
            entries = [e for e in entries if not e.name.startswith(".")]
        if not entries:
            return f"目录 {directory} 为空"
        lines = [f"目录 {directory} 包含 {len(entries)} 个条目:"]
        for entry in entries:
            prefix = "[DIR] " if entry.is_dir() else "[FILE]"
            size = f"{entry.stat().st_size} bytes" if entry.is_file() else ""
            lines.append(f"  {prefix} {entry.name} {size}".strip())
        return "\n".join(lines)
    except Exception as exc:
        return _format_tool_error(exc, "list_directory")

@tool
def run_cli_safely(command: str, cli_args: _CliArgs = None, cwd: str = "", confirmed: bool = False) -> str:
    """安全执行命令行程序，统一处理中文路径与编码问题。仅用于 dir/ls/mkdir 等文件命令。
    ⚠️ 禁止用本工具调用 ffmpeg 做格式转换 — 必须使用 transcode_audio 工具。
    权限模式说明：
    - 完全访问模式（full）：所有白名单命令直接执行，无需确认
    - 标准模式（standard）：危险命令（del/rmdir 等删除类）必须先向用户确认，再传 confirmed=True 执行
    - 受限模式（restricted）：危险命令被拒绝
    Args: command: 可执行程序名或路径（如 "ffmpeg" 或 "python"）, cli_args: 参数列表，每个元素单独一项；含中文或空格的路径直接作为列表元素传入，不要手动拼接引号, cwd: 可选工作目录，留空则在当前目录执行, confirmed: 是否已向用户确认删除类操作（标准模式下必须为 True 才能执行危险命令）
    """
    try:
        import subprocess
        cmd_list = [command]
        for a in (cli_args or []):
            if isinstance(a, (list, tuple)):
                cmd_list.extend(str(x) for x in a)
            else:
                cmd_list.append(str(a))
        if not cmd_list[0]:
            return "错误：command 不能为空"
        # 提取基本命令名（去掉路径），转小写用于白名单匹配
        cmd_basename = pathlib.Path(cmd_list[0]).name.lower()
        permission_mode = _get_permission_mode()
        # ⚠️ ffmpeg 拦截：禁止用 run_cli_safely 执行 ffmpeg 做音频转码
        if cmd_basename in ("ffmpeg", "ffmpeg.exe"):
            # 检查是否是转码操作（有 -i 输入 + 输出文件）
            is_transcode = False
            cli_args_list = cli_args or []
            for i, arg in enumerate(cli_args_list):
                if arg in ("-i", "-f", "-c:a", "-ab", "-ar", "-ac", "-vn"):
                    is_transcode = True
                    break
                # 如果最后一个参数看起来像输出文件（不是 flag 开头）
                if i == len(cli_args_list) - 1 and isinstance(arg, str) and not arg.startswith("-"):
                    # 有输入文件参数，大概率是转码
                    if any(a in ("-i",) for a in cli_args_list):
                        is_transcode = True
                        break
            if is_transcode or len(cli_args_list) >= 2:
                print(f"[run_cli_safely] 拦截 ffmpeg 转码请求，引导使用 transcode_audio")
                return (
                    "⚠️ 禁止用 run_cli_safely 调用 ffmpeg 做音频格式转换。\n"
                    "请改用 transcode_audio 工具，参数:\n"
                    "- input_path: 源文件或目录\n"
                    "- target_format: 目标格式 (mp3/m4a/flac/wav/ogg)\n"
                    "- output_dir: 输出目录（可选）\n"
                    "示例: transcode_audio(input_path='/path/to/files', target_format='ogg', output_dir='/output')"
                )
        # 检查命令是否在白名单中
        if cmd_basename not in _ALLOWED_CLI_COMMANDS:
            # 非白名单命令：根据权限模式决定
            if permission_mode == "restricted":
                print(f"[run_cli_safely] 受限模式，拒绝执行非白名单命令: {cmd_basename}")
                return f"受限模式下不允许执行非白名单命令：{cmd_basename}，请切换到标准或完全访问模式。"
            # standard/full 模式：LLM 已决定调用此命令，信任其判断（不再弹窗询问）
            print(f"[run_cli_safely] {'标准' if permission_mode == 'standard' else '完全访问'}模式，LLM 自授权执行非白名单命令: {cmd_basename}")
        elif cmd_basename in _DANGEROUS_CLI_COMMANDS:
            # 危险命令：根据权限模式决定
            if permission_mode == "restricted":
                print(f"[run_cli_safely] 受限模式，拒绝执行危险命令: {cmd_basename}")
                return f"受限模式下不允许执行危险命令：{cmd_basename}，请切换到标准或完全访问模式。"
            if permission_mode == "standard" and not confirmed:
                # 标准模式：拦截删除类操作，要求模型先确认
                destructive = detect_destructive_intent(cmd_list)
                if destructive:
                    print(f"[run_cli_safely] 标准模式，拦截危险删除操作: {cmd_basename} confirmed={confirmed}")
                    return (
                        f"⚠️ 这是一个删除/破坏性操作，必须先向用户确认。\n"
                        f"请用通俗语言向用户解释该操作的目的和效果（不要显示命令行），"
                        f"然后调用 ask_user 让用户确认。用户确认后，再次调用本工具并传 confirmed=True。\n"
                        f"操作类型: {destructive}"
                    )
            print(f"[run_cli_safely] {'标准' if permission_mode == 'standard' else '完全访问'}模式，执行危险命令: {cmd_basename} confirmed={confirmed}")
        work_dir = str(pathlib.Path(cwd).resolve()) if cwd.strip() else None
        print(f"[run_cli_safely] cmd={cmd_list} cwd={work_dir} mode={permission_mode}")
        # 加 -nostdin 防止命令等待 stdin 挂起（ffmpeg 常见陷阱）
        if "-nostdin" not in cmd_list and cmd_list[0].lower().endswith(("ffmpeg", "ffmpeg.exe", "ffprobe", "ffprobe.exe")):
            cmd_list = [cmd_list[0], "-nostdin", *cmd_list[1:]]
        timeout = 300  # 与 transcoder._run_ffmpeg_safely 保持一致
        try:
            completed = subprocess.run(
                cmd_list,
                shell=False,
                cwd=work_dir,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout,
            )
        except subprocess.TimeoutExpired as exc:
            # 超时强制清理整个进程树（Windows taskkill /F /T）
            if os.name == "nt":
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(exc.pid)], capture_output=True, errors="replace")
            print(f"[run_cli_safely] 超时 ({timeout}s) 强制终止: {cmd_list}")
            return f"命令执行超时 ({timeout}s)，已强制终止"
        stdout = (completed.stdout or "")
        stderr = (completed.stderr or "")
        print(f"[run_cli_safely] returncode={completed.returncode}")
        result = f"退出码: {completed.returncode}\n--- stdout ---\n{stdout}"
        if stderr:
            result += f"\n--- stderr ---\n{stderr}"
        return result
    except FileNotFoundError as exc:
        return f"错误：命令未找到 - {exc}"
    except Exception as exc:
        return f"命令执行失败：{exc}"
@tool
def detect_format(file_path: str) -> str:
    """检测音频文件的容器格式（flac/mp3/m4a/wav/ogg/bin）。
    Args: file_path: 音频文件路径
    """
    try:
        path = _to_path(file_path)
        if not path.exists():
            return f"错误：文件不存在 - {file_path}"
        with path.open("rb") as f:
            head = f.read(64)
        container = detect_extension(head, "bin")
        size = path.stat().st_size
        return f"文件: {path.name}\n大小: {size} bytes\n容器格式: {container}\n文件头 (hex): {head[:32].hex()}"
    except Exception as exc:
        return _format_tool_error(exc, "detect_format")

@tool
def ask_user(question: str, options: list[str]) -> str:
    """遇到不确定的操作时询问用户如何处理。调用后会弹出对话框等待用户选择。
    使用时机：目标路径冲突/工具返回多种恢复路径/需要用户确认的操作。
    Args: question: 向用户提出的清晰问题, options: 2~4 个互斥选项字符串
    """
    print(f"[ask_user] question={question[:80]} options={options}")
    callback = _get_ask_user_callback()
    if callback is None:
        return "错误：ask_user 回调未注入（worker 未启动）"
    if not question.strip():
        return "错误：question 不能为空"
    clean_options = [str(o).strip() for o in options if str(o).strip()]
    if len(clean_options) < 2:
        return "错误：options 至少需要 2 个有效选项"
    try:
        answer = callback(question, clean_options)
        print(f"[ask_user] 用户选择: {answer}")
        return f"用户选择：{answer}"
    except Exception as exc:
        print(f"[ask_user] 异常: {exc}")
        return _format_tool_error(exc, "ask_user")

@tool
def sandbox_manage(action: str, path: str = "") -> str:
    """管理文件操作沙箱：授权/取消授权目录、查看当前授权目录。
    支持: status(查看) / add(授权) / remove(取消授权) / clear(清空) / enable(启用) / disable(禁用)
    Args: action: 操作类型, path: 目录路径（add/remove 必填）
    """
    try:
        sandbox = get_sandbox()
        action_lower = action.strip().lower()
        if action_lower == "status":
            status = sandbox.get_status()
            paths = status["authorized_paths"]
            paths_str = "\n".join(f"  - {p}" for p in paths) if paths else "  （无）"
            return (
                f"沙箱状态:\n"
                f"  启用: {'是' if status['enabled'] else '否'}\n"
                f"  授权目录数: {status['paths_count']}\n"
                f"  授权目录:\n{paths_str}"
            )
        elif action_lower == "add":
            if not path.strip():
                return "错误: add 操作需要指定 path 参数"
            added = sandbox.add_path(path)
            if added:
                return f"已授权目录: {path}"
            return f"目录已在授权范围内: {path}（无需重复授权）"
        elif action_lower == "remove":
            if not path.strip():
                return "错误: remove 操作需要指定 path 参数"
            if sandbox.remove_path(path):
                return f"已取消授权: {path}"
            return f"目录不在授权列表中: {path}"
        elif action_lower == "clear":
            sandbox.clear()
            return "已清空所有授权目录"
        elif action_lower == "enable":
            sandbox.enabled = True
            return "沙箱已启用"
        elif action_lower == "disable":
            sandbox.enabled = False
            return "沙箱已禁用（所有路径均可操作）"
        else:
            return f"未知操作: {action}，支持的操作: status, add, remove, clear, enable, disable"
    except PermissionError as exc:
        return f"权限错误: {exc}"
    except ValueError as exc:
        return f"参数错误: {exc}"
    except Exception as exc:
        return _format_tool_error(exc, "sandbox_manage")

__all__ = [
    "copy_files",
    "move_files",
    "rename_file",
    "list_directory",
    "run_cli_safely",
    "detect_format",
    "ask_user",
    "sandbox_manage",
]
