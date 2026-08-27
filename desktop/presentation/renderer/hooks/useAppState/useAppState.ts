/** Top-level app state hook — composition layer.
 *
 * Actual state ownership is split across useAppState.agent.ts (agent/LLM
 * state + handlers), useAppState.events.ts (IPC listeners), and this file
 * which holds the remaining UI state + navigation + settings glue.
 *
 * Re-exports all types/helpers for backwards-compatible imports.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { PermissionMode } from "../../../../application/tools/toolProtocol";
import type { ModelConfig } from "../../../../application/model/modelProtocol";
import { useAppSettings } from "../../useAppSettings";

// --- Re-exports for consumers ---
export type { Page, FileItem, HistoryItem, LlmMessage, AgentQuestion, ToolEvent, BatchProgressState, AgentSegment } from "./useAppState.types";
export { INITIAL_FILES, HISTORY_STORAGE_KEY, loadHistoryFromStorage, PERMISSION_MODE_MAP, REVERSE_MODE_MAP, AGENT_TRIGGER_KEYWORDS, TOOL_ACTION_PATTERN } from "./useAppState.helpers";
import { INITIAL_FILES, HISTORY_STORAGE_KEY, loadHistoryFromStorage, PERMISSION_MODE_MAP, TOOL_ACTION_PATTERN } from "./useAppState.helpers";
import type { Page, FileItem, HistoryItem, BatchProgressState, AgentSegment } from "./useAppState.types";
import { useAgentState } from "./useAppState.agent";
import { useModelEventListener, useWorkerEventListener, useSessionWarningListener } from "./useAppState.events";

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

  // --- Non-agent state ---
  const [page, setPage] = useState<Page>("dashboard");
  const [routeHistory, setRouteHistory] = useState<Page[]>(["dashboard"]);
  const [settingsTab, setSettingsTab] = useState("model");
  const [queue, setQueue] = useState<FileItem[]>(INITIAL_FILES);
  const [history, setHistory] = useState<HistoryItem[]>(() => loadHistoryFromStorage());

  useEffect(() => {
    try { localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history)); } catch (err) {
      console.warn("[useAppState] 保存历史到 localStorage 失败:", err);
    }
  }, [history]);

  const [libraryQuery, setLibraryQuery] = useState("");
  const [libraryPlatform, setLibraryPlatform] = useState("全部");
  const [libraryFormat, setLibraryFormat] = useState("全部");
  const [executionCollapsed, setExecutionCollapsed] = useState(true);
  const [contextUsage, setContextUsage] = useState(24);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [autoCompression, setAutoCompression] = useState(false);
  const [compressionThreshold, setCompressionThreshold] = useState(80);
  const [networkEnabled, setNetworkEnabledState] = useState(true);
  const [mode, setMode] = useState("标准");
  const [modelConfig, setModelConfig] = useState<ModelConfig>(modelCfg);
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [modal, setModal] = useState<"approval" | null>(null);
  const [toast, setToast] = useState("");
  const [promptText, setPromptText] = useState("");
  const [attachedPaths, setAttachedPaths] = useState<string[]>([]);
  const [batchProgress, setBatchProgress] = useState<BatchProgressState>({
    active: false, kind: "generic", totalCount: 0, currentIndex: 0, currentProgress: 0,
    successCount: 0, skippedCount: 0, failedCount: 0, finished: false,
  });
  const [agentSegments, setAgentSegments] = useState<AgentSegment[]>([]);
  const [compressionDone, setCompressionDone] = useState(false);
  const dashboardPromptRef = useRef<string | null>(null);

  // --- Navigation ---
  const navigateTo = useCallback((target: Page) => {
    console.info("[useAppState] navigate:", target);
    setRouteHistory((prev) => [...prev, target]);
    setPage(target);
  }, []);

  // --- Agent state (delegated) ---
  const agent = useAgentState({
    permMode,
    netEnabled,
    modelConfig,
    page,
    showToast,
    toolActionPattern: TOOL_ACTION_PATTERN,
    promptText,
    setPromptText,
    navigateTo,
    setAgentSegments,
    setBatchProgress,
  });

  // --- Settings hydration ---
  useEffect(() => {
    if (settings) {
      setNetworkEnabledState(settings.network.enabled);
      setMode(PERMISSION_MODE_MAP[settings.security.permissionMode] || "标准");
      if (settings.workspace.workspaceRoot) setWorkspaceRoot(settings.workspace.workspaceRoot);
      if (settings.model.defaultConfig.baseUrl) setModelConfig({ ...modelCfg, ...settings.model.defaultConfig });
    }
  }, [settings]);

  useEffect(() => {
    if (!settings) return;
    setContextUsage(Math.round(Math.random() * 30 + 60));
  }, [settings]);

  // --- Toast helper ---
  function showToast(message: string) {
    console.info("[useAppState] toast:", message);
    setToast(message);
    setTimeout(() => setToast(""), 2200);
  }

  // --- Event listeners ---
  useModelEventListener({
    llmRequestIdRef: agent.llmRequestIdRef,
    llmTextRef: agent.llmTextRef,
    llmReasoningRef: agent.llmReasoningRef,
    setLlmStreaming: agent.setLlmStreaming,
    setLlmThinking: agent.setLlmThinking,
    setLlmMessages: agent.setLlmMessages,
    setLlmTested: agent.setLlmTested,
    showToast,
    setToolEvents: agent.setToolEvents,
  });

  useWorkerEventListener({
    agentTaskIdRef: agent.agentTaskIdRef,
    showToast,
    setToolEvents: agent.setToolEvents,
    setAgentMessages: agent.setAgentMessages,
    setAgentQuestion: agent.setAgentQuestion,
    setHistory,
    setProcessing: agent.setProcessing,
    setProgress: agent.setProgress,
    setStepIndex: agent.setStepIndex,
    setTaskStatus: agent.setTaskStatus,
    toolActionPattern: TOOL_ACTION_PATTERN,
    setBatchProgress,
    setAgentSegments,
  });

  useSessionWarningListener(showToast);

  const routeBack = useCallback(() => {
    setRouteHistory((prev) => {
      if (prev.length <= 1) return prev;
      const next = prev.slice(0, -1);
      setPage(next[next.length - 1] || "dashboard");
      return next;
    });
  }, []);

  // --- Network / Permission / Settings handlers ---
  const toggleNetwork = useCallback(async () => {
    const newValue = !networkEnabled;
    setNetworkEnabledState(newValue);
    try {
      await updateNetworkEnabled(newValue);
      if (page === "llm") {
        agent.setLlmMessages((prev) => [...prev, { role: "notice", text: `已切换为${newValue ? "联网检索模式" : "离线模式"}` }]);
      } else {
        showToast(newValue ? "已开启联网" : "已关闭联网");
      }
    } catch {
      setNetworkEnabledState(!newValue);
      showToast("联网设置保存失败");
    }
  }, [networkEnabled, updateNetworkEnabled, page]);

  const selectMode = useCallback(async (modeKey: PermissionMode) => {
    const label = PERMISSION_MODE_MAP[modeKey];
    const prevLabel = PERMISSION_MODE_MAP[mode === "受限" ? "restricted" : mode === "标准" ? "standard" : "full"];
    setMode(label);
    try {
      await updatePermissionMode(modeKey);
      if (page === "llm") {
        agent.setLlmMessages((prev) => [...prev, { role: "notice", text: `已切换为${label}模式` }]);
      } else {
        showToast(`已切换为${label}模式`);
      }
    } catch {
      setMode(prevLabel);
      showToast("权限模式保存失败");
    }
  }, [mode, updatePermissionMode, page]);

  const saveConfig = useCallback(async () => {
    // 设置页每次改字段时已经通过 updateModelConfig 实时保存（包括 apiKey）
    // 这里再 push 一次确保最新值落盘
    if (settings?.model.defaultConfig) {
      await updateModelConfig(modelConfig);
      showToast("设置已保存");
    }
  }, [settings, modelConfig, updateModelConfig, showToast]);

  // --- Model / Session operations ---
  const resetModel = useCallback(async () => {
    const defaultModel = { ...modelConfig, model: "DeepSeek-R1" };
    setModelConfig(defaultModel);
    agent.setLlmTested(false);
    await updateModelConfig(defaultModel);
    showToast("已恢复推荐模型配置");
  }, [modelConfig, updateModelConfig]);

  const compressContext = useCallback(async () => {
    try {
      const defaults = settings?.compression.defaults;
      const result = await window.triMusicAgent.compressSession(defaults ?? { thresholdTokens: 1200, preserveRecentMessages: 4 });
      const msg = result.fallback ? "压缩失败，已继续使用原始会话。" : result.compressed ? `上下文已从约 ${result.estimatedTokensBefore} Token 压缩至 ${result.estimatedTokensAfter} Token。` : "尚未达到压缩阈值。";
      showToast(msg);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "压缩失败");
    }
  }, [settings]);

  const createSession = useCallback(async () => {
    try {
      await window.triMusicAgent.createSession();
      showToast("新会话已创建");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "创建会话失败");
    }
  }, [showToast]);

  const submitFromDashboard = useCallback((text: string) => {
    const cleaned = text.trim();
    if (!cleaned) { showToast("先告诉 TriMusicAgent 你的想法"); return; }
    dashboardPromptRef.current = cleaned;
    setPromptText(cleaned);
    agent.setConversationMode(true);
    navigateTo("llm");
  }, [navigateTo, showToast]);

  const addFile = useCallback((folder = false) => {
    const suffix = queue.length + 1;
    if (folder) {
      setQueue((prev) => [...prev,
      { id: `f${Date.now()}a`, title: `新歌单-${suffix}.ncm`, artist: "模拟艺术家", platform: "网易云音乐", input: "ncm", output: "flac", size: "12.40 MB", status: "待处理", cover: "cover-f" },
      { id: `f${Date.now()}b`, title: `现场录音-${suffix}.mgg`, artist: "模拟艺术家", platform: "QQ 音乐", input: "mgg", output: "flac", size: "18.20 MB", status: "待处理", cover: "cover-g" },
      ]);
      showToast("已添加模拟文件夹（2 个文件）");
    } else {
      setQueue((prev) => [...prev, { id: `f${Date.now()}`, title: `新增音乐-${suffix}.ncm`, artist: "模拟艺术家", platform: "网易云音乐", input: "ncm", output: "flac", size: "11.20 MB", status: "待处理", cover: "cover-f" }]);
      showToast("已添加模拟音乐文件");
    }
  }, [queue.length, showToast]);

  return {
    settings, page, setPage, navigateTo, routeBack,
    settingsTab, setSettingsTab,
    queue, setQueue,
    history, setHistory,
    libraryQuery, setLibraryQuery,
    libraryPlatform, setLibraryPlatform,
    libraryFormat, setLibraryFormat,
    executionCollapsed, setExecutionCollapsed,
    contextUsage, setContextUsage,
    modeMenuOpen, setModeMenuOpen,
    autoCompression, setAutoCompression,
    compressionThreshold, setCompressionThreshold,
    modal, setModal,
    toast, showToast,
    promptText, setPromptText,
    attachedPaths, setAttachedPaths,
    batchProgress,
    agentSegments,
    compressionDone, setCompressionDone,
    dashboardPromptRef,
    // spread agent state
    ...agent,
    // navigation + settings
    networkEnabled, toggleNetwork,
    mode, selectMode,
    modelConfig, setModelConfig, updateModelConfig,
    saveConfig, resetModel,
    compressContext, createSession,
    submitFromDashboard, addFile,
    resetSettings,
    workspaceRoot,
  };
}

export type UseAppStateResult = ReturnType<typeof useAppState>;
