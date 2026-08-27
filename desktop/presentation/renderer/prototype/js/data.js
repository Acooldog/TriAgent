export const PAGES = [
  ["dashboard", "处理台", "01"],
  ["llm", "模型服务", "07"],
  ["task", "当前任务", "02"],
  ["library", "音乐库", "03"],
  ["history", "任务历史", "04"],
  ["diagnostics", "诊断中心", "05"],
  ["settings", "设置", "06"],
];

export const files = [
  { id: "f1", title: "晴天.mgg", artist: "周杰伦", platform: "QQ 音乐", input: "mgg", output: "flac", size: "8.62 MB", status: "处理中", cover: "cover-a" },
  { id: "f2", title: "夜曲.ncm", artist: "周杰伦", platform: "网易云音乐", input: "ncm", output: "flac", size: "25.31 MB", status: "待处理", cover: "cover-b" },
  { id: "f3", title: "稻香.qmc3", artist: "周杰伦", platform: "QQ 音乐", input: "qmc3", output: "flac", size: "9.14 MB", status: "待处理", cover: "cover-c" },
  { id: "f4", title: "说好的幸福呢.mp3", artist: "周杰伦", platform: "本地文件", input: "mp3", output: "flac", size: "10.21 MB", status: "已完成", cover: "cover-d" },
  { id: "f5", title: "七里香.kgm", artist: "周杰伦", platform: "QQ 音乐", input: "kgm", output: "mp3", size: "7.08 MB", status: "失败", cover: "cover-e" },
];

export const history = [
  { title: "周杰伦音乐批量处理", date: "今天 14:32", total: 5, success: 4, failed: 1, status: "部分失败", time: "00:06:32" },
  { title: "清理歌单处理", date: "今天 11:08", total: 12, success: 12, failed: 0, status: "成功", time: "00:12:44" },
  { title: "网易云歌曲导出处理", date: "昨天 19:24", total: 28, success: 25, failed: 3, status: "部分失败", time: "00:18:23" },
  { title: "QQ 音乐批量处理", date: "昨天 16:10", total: 18, success: 18, failed: 0, status: "成功", time: "00:15:08" },
  { title: "旧歌曲恢复处理", date: "更早 08-19", total: 7, success: 7, failed: 0, status: "成功", time: "00:05:21" },
];

export const diagnostics = [
  ["QQ 音乐注册表路径", "正常", "已检测", "2026-08-22 14:30"],
  ["QQ 音乐进程", "正常", "未运行", "2026-08-22 14:30"],
  ["网易云音乐路径", "正常", "已检测", "2026-08-22 14:30"],
  ["网易云音乐进程", "提示", "未运行（可选）", "2026-08-22 14:30"],
  ["FFmpeg", "正常", "ffmpeg 7.0.2", "2026-08-22 14:30"],
  ["Python worker", "正常", "待命中", "2026-08-22 14:30"],
  ["解密器", "正常", "版本 v2.1", "2026-08-22 14:30"],
  ["工作数据根目录", "正常", "D:\\TriMusicAgent\\Data", "2026-08-22 14:30"],
];

const DEFAULT_MODEL_CONFIG = {
  baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  model: "glm-4.5",
  apiKey: "",
  thinking: "enabled",
  maxTokens: 4096,
  temperature: 0.6,
  connectTimeoutMs: 60_000,
};

const PERMISSION_MODE_MAP = { restricted: "受限", standard: "标准", full: "完全访问" };

export function createState() {
  return {
    page: "dashboard",
    routeHistory: ["dashboard"],
    variant: "studio",
    mode: "标准",
    settingsTab: "model",
    queue: files.map((file) => ({ ...file })),
    history: history.map((item) => ({ ...item })),
    libraryQuery: "",
    libraryPlatform: "全部",
    libraryFormat: "全部",
    progress: 38,
    stepIndex: 1,
    processing: false,
    taskStatus: "处理中",
    compressionDone: false,
    modal: null,
    toast: "",
    workspaceRoot: "",
    sidebarWidth: 82,
    promptText: "",
    attachedPaths: [],
    lastLlmPrompt: "",
    llmMessages: [],
    llmStreaming: null,
    llmRetry: null,
    executionCollapsed: true,
    contextUsage: 24,
    compressionThreshold: 80,
    modeMenuOpen: false,
    llmOutputSpeed: 45,
    networkEnabled: true,
    autoCompression: false,
    conversationMode: false,
    agentMessages: [],
    toolEvents: [],
    processStep: 0,
    llmModel: "DeepSeek-R1",
    llmProvider: "OpenAI-compatible",
    llmTested: false,
    modelConfig: { ...DEFAULT_MODEL_CONFIG },
    settingsLoaded: false,
  };
}

export async function loadSettingsFromMain(state) {
  const debug = (event, payload = {}) => console.info(`[TriMusicAgent][settings] ${event}`, payload);
  debug("loading-from-main");
  try {
    const settings = await window.triMusicAgent.getAppSettings();
    debug("loaded-from-main", {
      networkEnabled: settings.network.enabled,
      permissionMode: settings.security.permissionMode,
      modelConfigured: Boolean(settings.model.defaultConfig.baseUrl),
      workspaceRoot: settings.workspace.workspaceRoot,
      compressionThreshold: settings.compression.defaults.thresholdTokens,
    });

    state.networkEnabled = settings.network.enabled;
    state.mode = PERMISSION_MODE_MAP[settings.security.permissionMode] || "标准";
    if (settings.workspace.workspaceRoot) state.workspaceRoot = settings.workspace.workspaceRoot;
    if (settings.model.defaultConfig.baseUrl) {
      state.modelConfig = { ...DEFAULT_MODEL_CONFIG, ...settings.model.defaultConfig };
      state.llmModel = settings.model.defaultConfig.model || state.llmModel;
    }
    if (settings.compression.defaults.thresholdTokens) {
      state.compressionThreshold = Math.round(settings.compression.defaults.thresholdTokens / 100);
    }
    state.settingsLoaded = true;
    debug("applied-to-state", { networkEnabled: state.networkEnabled, mode: state.mode });
  } catch (error) {
    console.error("[TriMusicAgent][settings] 加载失败", error instanceof Error ? error.message : error);
  }
}
