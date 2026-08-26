/** Agent/LLM state + handlers — extracted from useAppState for cohesion.
 *
 * This hook owns all agent-worker and LLM-chat related state and action
 * handlers. It is consumed by useAppState.ts which spreads its results
 * into the final return object.
 */
import { useCallback, useRef, useState } from "react";
import type { PermissionMode } from "../../../../application/tools/toolProtocol";
import type { ModelConfig } from "../../../../application/model/modelProtocol";
import { AGENT_TRIGGER_KEYWORDS } from "./useAppState.helpers";
import type { AgentQuestion, LlmMessage, Page, ToolEvent } from "./useAppState.types";

interface UseAgentStateOptions {
  permMode: PermissionMode;
  netEnabled: boolean;
  modelConfig: ModelConfig;
  page: string;
  showToast: (msg: string) => void;
  toolActionPattern: RegExp;
  promptText: string;
  setPromptText: (text: string) => void;
  navigateTo: (target: Page) => void;
}

export function useAgentState({
  permMode,
  netEnabled,
  modelConfig,
  page,
  showToast,
  toolActionPattern,
  promptText,
  setPromptText,
  navigateTo,
}: UseAgentStateOptions) {
  // --- LLM streaming state ---
  const [llmMessages, setLlmMessages] = useState<LlmMessage[]>([]);
  const [llmStreaming, setLlmStreaming] = useState<{ text: string; index: number } | null>(null);
  const [llmThinking, setLlmThinking] = useState(false);
  const [llmTested, setLlmTested] = useState(false);
  const [lastLlmPrompt, setLastLlmPrompt] = useState("");
  const [llmRetry, setLlmRetry] = useState<{ attempt: number; max: number } | null>(null);
  const llmRequestIdRef = useRef<string | null>(null);
  const llmTextRef = useRef("");
  const llmReasoningRef = useRef("");

  // --- Agent worker state ---
  const [agentMessages, setAgentMessages] = useState<LlmMessage[]>([]);
  const [agentQuestion, setAgentQuestion] = useState<AgentQuestion | null>(null);
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
  const [conversationMode, setConversationMode] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [taskStatus, setTaskStatus] = useState("处理中");
  const [progress, setProgress] = useState(38);
  const [stepIndex, setStepIndex] = useState(1);
  const agentTaskIdRef = useRef<string | null>(null);

  // --- Test model connection ---
  const testModelConnection = useCallback(async () => {
    if (!modelConfig.apiKey) { showToast("请先填写 API Key"); return; }
    if (!modelConfig.baseUrl) { showToast("请先配置 API Base URL"); return; }
    setLlmMessages((prev) => [...prev.filter((m) => m.role !== "notice"), { role: "notice", text: "正在测试模型连接……" }]);
    llmTextRef.current = "";
    llmReasoningRef.current = "";
    setLlmStreaming({ text: "", index: 0 });
    setLlmThinking(false);
    try {
      const result = await window.triMusicAgent.startModel(
        modelConfig,
        [{ role: "user" as const, content: "请只回复：连接成功" }],
        permMode,
        netEnabled
      );
      console.info("[useAgentState] model test started:", result.requestId);
      llmRequestIdRef.current = result.requestId;
    } catch (err) {
      const message = err instanceof Error ? err.message : "模型连接失败";
      console.error("[useAgentState] model test failed:", message);
      setLlmStreaming(null);
      setLlmMessages((prev) => [...prev.filter((m) => m.role !== "notice"), { role: "error", text: message }]);
      showToast(message);
    }
  }, [modelConfig, permMode, netEnabled, showToast]);

  // --- Send prompt (LLM chat or Agent trigger) ---
  const sendPrompt = useCallback(async () => {
    const userText = promptText.trim();
    if (!userText) { showToast("先告诉 TriMusicAgent 你的想法"); return; }
    setPromptText("");

    if (AGENT_TRIGGER_KEYWORDS.test(userText)) {
      setConversationMode(true);
      setAgentMessages((prev) => [...prev.filter((m) => m.role !== "notice"), { role: "user", text: userText }]);
      setToolEvents([]);
      setStepIndex(0);
      setProgress(0);
      setProcessing(true);
      setTaskStatus("连接中");
      showToast("检测到音乐处理请求，正在启动 Agent...");
      const modelCfg = buildModelCfg(modelConfig);
      try {
        const history = agentMessages
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({ role: m.role, content: m.text }));
        const result = await window.triMusicAgent.startWorker(
          "agent",
          { message: userText, model_config: modelCfg, max_iterations: 40, conversation_history: history },
          permMode
        );
        agentTaskIdRef.current = result.taskId;
        console.info("[useAgentState] agent worker started (sendPrompt):", result.requestId);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Agent 启动失败";
        setProcessing(false);
        setTaskStatus("失败");
        setAgentMessages((prev) => [...prev, { role: "error", text: message }]);
        showToast(message);
      }
      if (page !== "llm") navigateTo("llm");
      return;
    }

    setLastLlmPrompt(userText);
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
    try {
      const result = await window.triMusicAgent.startModel(
        modelConfig,
        [...llmMessages.filter((m) => m.role === "user" || m.role === "assistant").map((m) => ({ role: m.role as "user" | "assistant", content: m.text })), { role: "user" as const, content: userText }],
        permMode,
        netEnabled
      );
      llmRequestIdRef.current = result.requestId;
    } catch (err) {
      const message = err instanceof Error ? err.message : "模型连接失败";
      setLlmStreaming(null);
      setLlmMessages((prev) => [...prev, { role: "error", text: message }]);
      showToast(message);
    }
  }, [promptText, setPromptText, modelConfig, permMode, netEnabled, showToast, page, agentMessages, llmMessages, navigateTo]);

  // --- Agent worker operations ---
  const startProcessing = useCallback(async () => {
    if (processing) { showToast("任务已经在处理中"); return; }
    const userText = promptText.trim();
    if (!userText) { showToast("先告诉 Agent 你想处理什么"); return; }
    setPromptText("");
    setConversationMode(true);
    setAgentMessages((prev) => [...prev.filter((m) => m.role !== "notice"), { role: "user", text: userText }]);
    setToolEvents([]);
    setStepIndex(0);
    setProgress(0);
    setProcessing(true);
    setTaskStatus("连接中");
    showToast("正在启动 Agent...");
    const modelCfg = buildModelCfg(modelConfig);
    const history = agentMessages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: m.text }));
    try {
      const result = await window.triMusicAgent.startWorker(
        "agent",
        { message: userText, model_config: modelCfg, max_iterations: 15, conversation_history: history },
        permMode
      );
      agentTaskIdRef.current = result.taskId;
      console.info("[useAgentState] agent worker started:", result.requestId);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Agent 启动失败";
      setProcessing(false);
      setTaskStatus("失败");
      setAgentMessages((prev) => [...prev, { role: "error", text: message }]);
      showToast(message);
    }
  }, [promptText, setPromptText, processing, modelConfig, permMode, agentMessages, showToast]);

  const stopProcessing = useCallback(async () => {
    const taskId = agentTaskIdRef.current;
    if (taskId) {
      try { await window.triMusicAgent.cancelWorker(taskId); } catch { /* ignore */ }
      agentTaskIdRef.current = null;
    }
    setProcessing(false);
    setTaskStatus("已停止");
    showToast("任务已停止");
  }, [showToast]);

  const stopLlmStreaming = useCallback(async () => {
    const requestId = llmRequestIdRef.current;
    if (requestId) {
      try { await window.triMusicAgent.cancelModel(requestId); } catch { /* ignore */ }
    }
    setLlmStreaming(null);
    setLlmThinking(false);
    llmTextRef.current = "";
    llmReasoningRef.current = "";
    llmRequestIdRef.current = null;
    showToast("已打断回复");
  }, [showToast]);

  const sendSupplement = useCallback(async () => {
    if (!processing) { showToast("任务未在运行"); return; }
    const userText = promptText.trim();
    if (!userText) { showToast("先输入补充内容"); return; }
    setPromptText("");
    const taskId = agentTaskIdRef.current;
    if (!taskId) { showToast("任务未启动"); return; }
    setAgentMessages((prev) => [...prev, { role: "user", text: userText }]);
    try {
      await window.triMusicAgent.sendWorkerSupplement(taskId, userText);
    } catch (err) {
      const message = err instanceof Error ? err.message : "补充发送失败";
      setAgentMessages((prev) => [...prev, { role: "error", text: message }]);
      showToast(message);
    }
  }, [promptText, setPromptText, processing, showToast]);

  const answerAgentQuestion = useCallback(async (answer: string) => {
    const q = agentQuestion;
    if (!q) { showToast("当前没有待回答的问题"); return; }
    const taskId = agentTaskIdRef.current;
    if (!taskId) { showToast("任务未启动"); setAgentQuestion(null); return; }
    setAgentQuestion(null);
    setAgentMessages((prev) => [...prev, { role: "user", text: answer }]);
    try {
      await window.triMusicAgent.sendWorkerAnswer(taskId, q.questionId, answer);
    } catch (err) {
      const message = err instanceof Error ? err.message : "回答发送失败";
      setAgentMessages((prev) => [...prev, { role: "error", text: message }]);
      showToast(message);
    }
  }, [agentQuestion, showToast]);

  return {
    // state
    llmMessages, setLlmMessages,
    llmStreaming, setLlmStreaming,
    llmThinking, setLlmThinking,
    llmTested, setLlmTested,
    lastLlmPrompt, setLastLlmPrompt,
    llmRetry, setLlmRetry,
    agentMessages, setAgentMessages,
    agentQuestion, setAgentQuestion,
    toolEvents, setToolEvents,
    conversationMode, setConversationMode,
    processing, setProcessing,
    taskStatus, setTaskStatus,
    progress, setProgress,
    stepIndex, setStepIndex,
    // refs
    llmRequestIdRef,
    llmTextRef,
    llmReasoningRef,
    agentTaskIdRef,
    // handlers
    testModelConnection,
    sendPrompt,
    startProcessing,
    stopProcessing,
    stopLlmStreaming,
    sendSupplement,
    answerAgentQuestion,
  };
}

function buildModelCfg(cfg: ModelConfig) {
  return {
    model: cfg.model,
    base_url: cfg.baseUrl,
    api_key: cfg.apiKey ?? "",
    temperature: cfg.temperature ?? 0.7,
    max_tokens: cfg.maxTokens ?? 4096,
  };
}
