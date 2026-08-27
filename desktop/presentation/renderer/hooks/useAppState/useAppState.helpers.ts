import type { PermissionMode } from "../../../../application/tools/toolProtocol";
import type { FileItem, HistoryItem } from "./useAppState.types";

// 初始为空数组，等待实际数据加载
export const INITIAL_FILES: FileItem[] = [];
export const HISTORY_STORAGE_KEY = "trimusic_history";

export function loadHistoryFromStorage(): HistoryItem[] {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(HISTORY_STORAGE_KEY) : null;
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as HistoryItem[];
    return [];
  } catch {
    return [];
  }
}

export const PERMISSION_MODE_MAP: Record<PermissionMode, string> = {
  restricted: "受限",
  standard: "标准",
  full: "完全访问",
};

export const REVERSE_MODE_MAP: Record<string, PermissionMode> = {
  "受限": "restricted",
  "标准": "standard",
  "完全访问": "full",
};

export const AGENT_TRIGGER_KEYWORDS = /解密|转换|转码|转成|批量|处理|压缩|kgma|kgg|mflac|qmc|kugou|酷狗|无损|flac|mp3|m4a|wav|ogg|音频|音乐文件|文件夹|目录|输出|输出到|提取|提取音频|下载|下载哔哩|bilibili|视频|视频文件/;

export const TOOL_ACTION_PATTERN = /参数[:：]|\n>\s*`|^>\s*`|调用.*工具|执行.*命令|正在调用|正在执行|^(正在|我现在|我先).*(扫描|解密|转码|转换|移动|复制|重命名|检测|调用|执行)/m;
