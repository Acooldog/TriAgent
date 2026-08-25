import { useCallback, useEffect, useRef, useState } from "react";
import type { AppSettings } from "../../../application/appSettings";
import type { PermissionMode } from "../../../application/toolProtocol";
import type { ModelConfig } from "../../../application/modelProtocol";
import { useAppSettings } from "../useAppSettings";

export type Page = "dashboard" | "llm" | "task" | "library" | "history" | "diagnostics" | "settings" | "recovery";

export interface FileItem {
  id: string;
  title: string;
  artist: string;
  platform: string;
  input: string;
  output: string;
  status: string;
  size: string;
  cover: string;
}

export interface HistoryItem {
  id: string;
  title: string;
  date: string;
  total: number;
  time: string;
  success: number;
  failed: number;
  status: string;
}

export interface LlmMessage {
  role: "user" | "assistant" | "error" | "notice";
  text: string;
}

export interface ToolEvent {
  name: string;
  detail: string;
  status: "done" | "running" | "pending";
}

const INITIAL_FILES: FileItem[] = [
  { id: "f1", title: "晴天.mgg", artist: "周杰伦", platform: "QQ 音乐", input: "mgg", output: "flac", size: "8.62 MB", status: "处理中", cover: "cover-a" },
  { id: "f2", title: "夜曲.ncm", artist: "周杰伦", platform: "网易云音乐", input: "ncm", output: "flac", size: "25.31 MB", status: "待处理", cover: "cover-b" },
  { id: "f3", title: "稻香.qmc3", artist: "周杰伦", platform: "QQ 音乐", input: "qmc3", output: "flac", size: "9.14 MB", status: "待处理", cover: "cover-c" },
  { id: "f4", title: "说好的幸福呢.mp3", artist: "周杰伦", platform: "本地文件", input: "mp3", output: "flac", size: "10.21 MB", status: "已完成", cover: "cover-d" },
  { id: "f5", title: "七里香.kgm", artist: "周杰伦", platform: "QQ 音乐", input: "kgm", output: "mp3", size: "7.08 MB", status: "失败", cover: "cover-e" },
];

const INITIAL_HISTORY: HistoryItem[] = [
  { id: "h1", title: "周杰伦音乐批量处理", date: "今天 14:32", total: 5, time: "00:06:32", success: 4, failed: 1, status: "部分失败" },
  { id: "h2", title: "清理歌单处理", date: "今天 11:08", total: 12, time: "00:12:44", success: 12, failed: 0, status: "成功" },
  { id: "h3", title: "网易云歌曲导出处理", date: "昨天 19:24", total: 28, time: "00:18:23", success: 25, failed: 3, status: "部分失败" },
  { id: "h4", title: "QQ 音乐批量处理", date: "昨天 16:10", total: 18, time: "00:15:08", success: 18, failed: 0, status: "成功" },
  { id: "h5", title: "旧歌曲恢复处理", date: "更早 08-19", total: 7, time: "00:05:21", success: 7, failed: 0, status: "成功" },
];

const PERMISSION_MODE_MAP: Record<PermissionMode, string> = { restricted: "受限", standard: "标准", full: "完全访问" };
const REVERSE_MODE_MAP: Record<string, PermissionMode> = { "受限": "restricted", "标准": "standard", "完全访问": "full" };

export function useAppState() {
  const {
    settings,
    networkEnabled: netEnabled,
    permissionMode: permMode,
    modelConfig: modelCfg,
    updateNetworkEnabled,
    updatePermissionMode,
    updateModelConfig,
    saveModelConfig,
    resetSettings,
  } = useAppSettings();

  const [page, setPage] = useState<Page>("dashboard");
  const [routeHistory, setRouteHistory] = useState<Page[]>(["dashboard"]);
  const [settingsTab, setSettingsTab] = useState("model");
  const [queue, setQueue] = useState<FileItem[]>(INITIAL_FILES);
  const [history, setHistory] = useState<HistoryItem[]>(INITIAL_HISTORY);
  const [libraryQuery, setLibraryQuery] = useState("");
  const [libraryPlatform, setLibraryPlatform] = useState("全部");
  const [libraryFormat, setLibraryFormat] = useState("全部");
  const [progress, setProgress] = useState(38);
  const [stepIndex, setStepIndex] = useState(1);
  const [processing, setProcessing] = useState(false);
  const [taskStatus, setTaskStatus] = useState("处理中");
  const [compressionDone, setCompressionDone] = useState(false);
  const [modal, setModal] = useState<"approval" | null>(null);
  const [toast, setToast] = useState("");
  const [promptText, setPromptText] = useState("");
  const [attachedPaths, setAttachedPaths] = useState<string[]>([]);
  const [lastLlmPrompt, setLastLlmPrompt] = useState("");
  const [llmMessages, setLlmMessages] = useState<LlmMessage[]>([]);
  const [llmStreaming, setLlmStreaming] = useState<{ text: string; index: number } | null>(null);
  const [llmRetry, setLlmRetry] = useState<{ attempt: number; max: number } | null>(null);
  const [executionCollapsed, setExecutionCollapsed] = useState(true);
  const [contextUsage, setContextUsage] = useState(24);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
  const [agentMessages, setAgentMessages] = useState<LlmMessage[]>([]);
  const [conversationMode, setConversationMode] = useState(false);
  const [autoCompression, setAutoCompression] = useState(false);
  const [compressionThreshold, setCompressionThreshold] = useState(80);
  const [llmTested, setLlmTested] = useState(false);
  const llmRequestIdRef = useRef<string | null>(null);
  const [llmThinking, setLlmThinking] = useState(false);
  const [llmDebugText, setLlmDebugText] = useState("");
  const [mode, setMode] = useState("标准");
  const [networkEnabled, setNetworkEnabledState] = useState(true);
  const [modelConfig, setModelConfig] = useState<ModelConfig>(modelCfg);
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const llmTextRef = useRef("");
  const llmReasoningRef = useRef("");
  const dashboardPromptRef = useRef<string | null>(null);

  useEffect(() => {
    if (settings) {
      setNetworkEnabledState(settings.network.enabled);
      setMode(PERMISSION_MODE_MAP[settings.security.permissionMode] || "标准");
      if (settings.workspace.workspaceRoot) setWorkspaceRoot(settings.workspace.workspaceRoot);
      if (settings.model.defaultConfig.baseUrl) {
        setModelConfig({ ...modelCfg, ...settings.model.defaultConfig });
      }
    }
  }, [settings]);

  const showToast = useCallback((message: string) => {
    console.info("[useAppState] toast:", message);
    setToast(message);
    setTimeout(() => setToast(""), 2200);
  }, []);

  useEffect(() => {
    let active = true;
    const cleanup = window.triMusicAgent.onModelEvent((payload: { requestId: string; event: { type: string; text?: string; message?: string; code?: string; finishReason?: string | null; index?: number; id?: string; name?: string; argumentsDelta?: string; toolCall?: { id: string; name: string; arguments: string; }; retryable?: boolean; status?: number } }) => {
      if (!active) return;
      const { requestId, event } = payload;
      if (requestId !== llmRequestIdRef.current) return;
      if (event.type === "text_delta") {
        const deltaText = event.text ?? "";
        llmTextRef.current += deltaText;
        setLlmThinking(false);
        setLlmStreaming({ text: llmTextRef.current, index: llmTextRef.current.length });
        setLlmDebugText(`text_delta[${deltaText.length}]: "${deltaText.slice(0, 80)}" | total: ${llmTextRef.current.length}`);
        console.info("[useAppState] text-delta:", { len: deltaText.length, text: deltaText.slice(0, 30), totalLen: llmTextRef.current.length });
      } else if (event.type === "reasoning_delta") {
        const deltaText = event.text ?? "";
        llmReasoningRef.current += deltaText;
        setLlmThinking(true);
        setLlmDebugText(`reasoning_delta[${deltaText.length}]: "${deltaText.slice(0, 80)}" | reasoningTotal: ${llmReasoningRef.current.length} | textTotal: ${llmTextRef.current.length}`);
      } else if (event.type === "tool_call_delta" && event.name) {
        setLlmThinking(false);
        const toolName = event.name;
        setToolEvents((events) => {
          const existing = events.find((e) => e.name === toolName && e.status === "running");
          if (existing) return events;
          return [...events, { name: toolName, detail: `工具调用中: ${toolName}`, status: "running" }];
        });
      } else if (event.type === "tool_call_accepted" && event.toolCall) {
        const toolCallName = event.toolCall.name;
        setToolEvents((events) => events.map((e) => e.name === toolCallName ? { ...e, status: "done", detail: `已批准: ${e.name}` } : e));
      } else if (event.type === "tool_call_rejected" && event.toolCall) {
        const toolCallName = event.toolCall.name;
        setToolEvents((events) => events.map((e) => e.name === toolCallName ? { ...e, status: "done", detail: `已拒绝: ${event.message ?? ""}` } : e));
      } else if (event.type === "response_completed") {
        setLlmStreaming(null);
        setLlmThinking(false);
        const rawText = llmTextRef.current;
        const reasoningText = llmReasoningRef.current;
        const finalText = rawText || reasoningText || "连接测试成功";
        setLlmDebugText(`DONE | textLen: ${rawText.length} | reasoningLen: ${reasoningText.length} | finalLen: ${finalText.length} | first100: "${finalText.slice(0, 100)}"`);
        console.info("[useAppState] response-completed:", { rawLen: rawText.length, reasoningLen: reasoningText.length, finalLen: finalText.length, firstChars: finalText.slice(0, 50) });
        setLlmMessages((prev) => [...prev.filter((m) => m.role !== "notice"), { role: "assistant", text: finalText }]);
        setLlmTested(true);
        llmRequestIdRef.current = null;
      } else if (event.type === "error") {
        setLlmStreaming(null);
        setLlmThinking(false);
        setLlmDebugText(`ERROR: ${event.message || "未知错误"}`);
        setLlmMessages((prev) => [...prev.filter((m) => m.role !== "notice"), { role: "error", text: event.message || "连接失败" }]);
        llmRequestIdRef.current = null;
        showToast(`连接失败：${event.message || "未知错误"}`);
      }
    });
    return () => { active = false; cleanup(); };
  }, [showToast]);

  useEffect(() => {
    let active = true;
    const cleanup = window.triMusicAgent.onSessionPersistenceWarning((payload: { requestId: string; message: string }) => {
      if (!active) return;
      console.warn("[useAppState] session-persistence-warning:", payload.message);
      showToast(payload.message);
    });
    return () => { active = false; cleanup(); };
  }, [showToast]);

  const navigateTo = useCallback((target: Page) => {
    console.info("[useAppState] navigate:", target);
    setRouteHistory((prev) => [...prev, target]);
    setPage(target);
    setConversationMode(false);
  }, []);

  const routeBack = useCallback(() => {
    console.info("[useAppState] route-back");
    setRouteHistory((prev) => {
      if (prev.length <= 1) return prev;
      const next = prev.slice(0, -1);
      setPage(next[next.length - 1] || "dashboard");
      return next;
    });
    setConversationMode(false);
  }, []);

  const toggleNetwork = useCallback(async () => {
    const newValue = !networkEnabled;
    console.info("[useAppState] toggle-network:", newValue);
    setNetworkEnabledState(newValue);
    try {
      await updateNetworkEnabled(newValue);
      if (page === "llm") {
        setLlmMessages((prev) => [...prev, { role: "notice", text: `已切换为${newValue ? "联网检索模式" : "离线模式"}` }]);
      } else {
        showToast(newValue ? "已开启联网" : "已关闭联网");
      }
    } catch {
      setNetworkEnabledState(!newValue);
      showToast("联网设置保存失败");
    }
  }, [networkEnabled, updateNetworkEnabled, page, showToast]);

  const selectMode = useCallback(async (modeKey: PermissionMode) => {
    const label = PERMISSION_MODE_MAP[modeKey];
    const prevLabel = PERMISSION_MODE_MAP[mode === "受限" ? "restricted" : mode === "标准" ? "standard" : "full"];
    console.info("[useAppState] select-mode:", label);
    setMode(label);
    try {
      await updatePermissionMode(modeKey);
      if (page === "llm") {
        setLlmMessages((prev) => [...prev, { role: "notice", text: `已切换为${label}模式` }]);
      } else {
        showToast(`已切换为${label}模式`);
      }
    } catch {
      setMode(prevLabel);
      showToast("权限模式保存失败");
    }
  }, [mode, updatePermissionMode, page, showToast]);

  const saveConfig = useCallback(async () => {
    console.info("[useAppState] save-config");
    if (settings?.model.defaultConfig) {
      const fullConfig: ModelConfig = { ...modelConfig };
      await saveModelConfig(fullConfig);
      showToast("设置已保存");
    }
  }, [settings, modelConfig, saveModelConfig, showToast]);

  const testModelConnection = useCallback(async () => {
    console.info("[useAppState] test-model-connection");
    if (!modelConfig.apiKey) { showToast("请先填写 API Key"); return; }
    if (!modelConfig.baseUrl) { showToast("请先配置 API Base URL"); return; }
    setLlmMessages((prev) => [...prev.filter((m) => m.role !== "notice"), { role: "notice", text: "正在测试模型连接……" }]);
    llmTextRef.current = "";
    llmReasoningRef.current = "";
    setLlmStreaming({ text: "", index: 0 });
    setLlmThinking(false);
    setLlmDebugText("");
    try {
      const result = await window.triMusicAgent.startModel(
        modelConfig,
        [{ role: "user" as const, content: "请只回复：连接成功" }],
        permMode,
        netEnabled
      );
      console.info("[useAppState] model test started:", result.requestId);
      llmRequestIdRef.current = result.requestId;
    } catch (err) {
      const message = err instanceof Error ? err.message : "模型连接失败";
      console.error("[useAppState] model test failed:", message);
      setLlmStreaming(null);
      setLlmMessages((prev) => [...prev.filter((m) => m.role !== "notice"), { role: "error", text: message }]);
      showToast(message);
    }
  }, [modelConfig, permMode, netEnabled, showToast]);

  const sendPrompt = useCallback(async () => {
    if (!promptText.trim()) { showToast("先告诉 TriMusicAgent 你的想法"); return; }
    console.info("[useAppState] send-prompt:", promptText.slice(0, 50));
    const userText = promptText.trim();
    setLastLlmPrompt(userText);
    setPromptText("");
    setLlmMessages((prev) => [...prev, { role: "user", text: userText }]);
    if (!modelConfig.apiKey || !modelConfig.baseUrl) {
      setLlmMessages((prev) => [...prev, { role: "notice", text: "请先在设置中配置模型 API Key 和 Base URL" }]);
      showToast("请先配置模型");
      return;
    }
    llmTextRef.current = "";
    llmReasoningRef.current = "";
    setLlmStreaming({ text: "", index: 0 });
    setLlmThinking(false);
    setLlmDebugText("");
    try {
      const result = await window.triMusicAgent.startModel(
        modelConfig,
        [...llmMessages.filter((m) => m.role === "user" || m.role === "assistant").map((m) => ({ role: m.role as "user" | "assistant", content: m.text })), { role: "user" as const, content: userText }],
        permMode,
        netEnabled
      );
      console.info("[useAppState] model chat started:", result.requestId);
      llmRequestIdRef.current = result.requestId;
    } catch (err) {
      const message = err instanceof Error ? err.message : "模型连接失败";
      console.error("[useAppState] model chat failed:", message);
      setLlmStreaming(null);
      setLlmMessages((prev) => [...prev, { role: "error", text: message }]);
      showToast(message);
    }
  }, [promptText, modelConfig, permMode, netEnabled, showToast, llmMessages]);

  const submitFromDashboard = useCallback((text: string) => {
    if (!text.trim()) { showToast("先告诉 TriMusicAgent 你的想法"); return; }
    dashboardPromptRef.current = text.trim();
    setPromptText(text.trim());
    navigateTo("llm");
  }, [navigateTo, showToast]);

  const compressContext = useCallback(async () => {
    console.info("[useAppState] compress-context");
    try {
      const defaults = settings?.compression.defaults;
      const result = await window.triMusicAgent.compressSession(defaults ?? { thresholdTokens: 1200, preserveRecentMessages: 4 });
      const msg = result.fallback ? "压缩失败，已继续使用原始会话。" : result.compressed ? `上下文已从约 ${result.estimatedTokensBefore} Token 压缩至 ${result.estimatedTokensAfter} Token。` : "尚未达到压缩阈值。";
      showToast(msg);
      setCompressionDone(true);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "压缩失败");
    }
  }, [settings, showToast]);

  const createSession = useCallback(async () => {
    console.info("[useAppState] create-session");
    try {
      await window.triMusicAgent.createSession();
      showToast("新会话已创建");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "创建会话失败");
    }
  }, [showToast]);

  const startProcessing = useCallback(() => {
    if (processing) { showToast("任务已经在处理中"); return; }
    if (!promptText.trim()) { showToast("先告诉 Agent 你想处理什么"); return; }
    setConversationMode(true);
    setPromptText("");
    setAgentMessages([
      { role: "user", text: promptText.trim() },
      { role: "assistant", text: "我先读取你的任务描述，再检查文件格式和可用工具。" },
    ]);
    setToolEvents([
      { name: "读取任务描述", status: "done", detail: "已解析处理目标" },
      { name: "扫描音乐文件", status: "running", detail: "等待扫描结果" },
      { name: "选择解密器", status: "pending", detail: "等待前一步完成" },
      { name: "运行 FFmpeg", status: "pending", detail: "等待前一步完成" },
      { name: "校验输出文件", status: "pending", detail: "等待前一步完成" },
    ]);
    setStepIndex(1);
    setProgress(42);
    setProcessing(true);
    setTaskStatus("处理中");
    showToast("已开始模拟处理任务");

    let count = 0;
    const timer = setInterval(() => {
      count++;
      setProgress((p) => {
        const next = Math.min(100, p + 14);
        return next;
      });
      setToolEvents((events) => events.map((event, i) => {
        const pct = Math.min(100, 42 + count * 14);
        const idx = Math.min(4, Math.floor(pct / 22));
        return {
          ...event,
          status: i < idx ? "done" : i === idx ? "running" : "pending",
          detail: i < idx ? "已完成模拟调用" : i === idx ? "Agent 正在处理" : "等待前一步完成",
        };
      }));
      setStepIndex((s) => Math.min(5, Math.floor((42 + count * 14) / 18)));
      if (count === 2) {
        setAgentMessages((prev) => [...prev, { role: "assistant", text: "已识别输入文件，正在按平台匹配解密器和转码工具。" }]);
      }
      if (count === 4) {
        setAgentMessages((prev) => [...prev, { role: "assistant", text: "工具链已准备完成，接下来校验输出文件。" }]);
      }
      if (count >= 5) {
        clearInterval(timer);
        setProcessing(false);
        setTaskStatus("成功");
        setToolEvents((events) => events.map((e) => ({ ...e, status: "done" as const, detail: "已完成模拟调用" })));
        setAgentMessages((prev) => [...prev, { role: "assistant", text: "任务已完成。所有操作均为模拟数据，没有执行真实解密或命令。" }]);
        setHistory((prev) => [{ id: `h-${Date.now()}`, title: "周杰伦音乐批量处理", date: "刚刚", total: queue.length, success: queue.length, failed: 0, status: "成功", time: "00:02:35" }, ...prev]);
        showToast("模拟任务已完成");
      }
    }, 900);
  }, [processing, promptText, queue.length, showToast]);

  const stopProcessing = useCallback(() => {
    setProcessing(false);
    setTaskStatus("已停止");
    showToast("任务已停止，未执行真实操作");
  }, [showToast]);

  const addFile = useCallback((folder = false) => {
    const suffix = queue.length + 1;
    if (folder) {
      const newFiles: FileItem[] = [
        { id: `f${Date.now()}a`, title: `新歌单-${suffix}.ncm`, artist: "模拟艺术家", platform: "网易云音乐", input: "ncm", output: "flac", size: "12.40 MB", status: "待处理", cover: "cover-f" },
        { id: `f${Date.now()}b`, title: `现场录音-${suffix}.mgg`, artist: "模拟艺术家", platform: "QQ 音乐", input: "mgg", output: "flac", size: "18.20 MB", status: "待处理", cover: "cover-g" },
      ];
      setQueue((prev) => [...prev, ...newFiles]);
      showToast("已添加模拟文件夹（2 个文件）");
    } else {
      const newFile: FileItem = { id: `f${Date.now()}`, title: `新增音乐-${suffix}.ncm`, artist: "模拟艺术家", platform: "网易云音乐", input: "ncm", output: "flac", size: "11.20 MB", status: "待处理", cover: "cover-f" };
      setQueue((prev) => [...prev, newFile]);
      showToast("已添加模拟音乐文件");
    }
  }, [queue.length, showToast]);

  const [llmChatSent, setLlmChatSent] = useState(false);

  const resetModel = useCallback(async () => {
    const defaultModel = { ...modelConfig, model: "DeepSeek-R1" };
    setModelConfig(defaultModel);
    setLlmTested(false);
    await updateModelConfig(defaultModel);
    showToast("已恢复推荐模型配置");
  }, [modelConfig, updateModelConfig, showToast]);

  useEffect(() => {
    if (!settings) return;
    setContextUsage(Math.round(Math.random() * 30 + 60));
  }, [settings]);

  return {
    settings,
    page, setPage, navigateTo, routeBack,
    settingsTab, setSettingsTab,
    queue, setQueue,
    history, setHistory,
    libraryQuery, setLibraryQuery,
    libraryPlatform, setLibraryPlatform,
    libraryFormat, setLibraryFormat,
    progress, setProgress,
    stepIndex, setStepIndex,
    processing, setProcessing,
    taskStatus, setTaskStatus,
    compressionDone, setCompressionDone,
    modal, setModal,
    toast, showToast,
    promptText, setPromptText,
    attachedPaths, setAttachedPaths,
    lastLlmPrompt, setLastLlmPrompt,
    llmMessages, setLlmMessages,
    llmStreaming, setLlmStreaming, llmTextRef,
    llmRetry, setLlmRetry,
    executionCollapsed, setExecutionCollapsed,
    contextUsage, setContextUsage,
    modeMenuOpen, setModeMenuOpen,
    toolEvents, setToolEvents,
    agentMessages, setAgentMessages,
    conversationMode, setConversationMode,
    autoCompression, setAutoCompression,
    compressionThreshold, setCompressionThreshold,
    llmTested, setLlmTested,
    llmThinking, setLlmThinking,
    llmDebugText,
    llmRequestIdRef,
    networkEnabled, toggleNetwork,
    mode, selectMode,
    modelConfig, setModelConfig, updateModelConfig,
    saveConfig, testModelConnection,
    sendPrompt, compressContext, submitFromDashboard, dashboardPromptRef,
    resetSettings, createSession,
    startProcessing, stopProcessing,
    addFile,
    workspaceRoot,
    resetModel,
    llmChatSent,
  };
}

export type UseAppStateResult = ReturnType<typeof useAppState>;
