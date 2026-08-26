import { useCallback, type Dispatch, type SetStateAction, type MutableRefObject } from "react";

export interface UseAgentSessionInput {
  setPromptText: (v: string) => void;
  setAgentMessages: Dispatch<SetStateAction<any[]>>;
  setToolEvents: Dispatch<SetStateAction<any[]>>;
  setStepIndex: Dispatch<SetStateAction<number>>;
  setProgress: Dispatch<SetStateAction<number>>;
  setProcessing: (v: boolean) => void;
  setTaskStatus: (v: string) => void;
  setAgentQuestion: Dispatch<SetStateAction<any | null>>;
  agentTaskIdRef: MutableRefObject<string | null>;
  setAgentTaskIdRef: (ref: MutableRefObject<string | null>) => void;
  modelConfig: any;
  permMode: string;
  showToast: (msg: string) => void;
  promptText: string;
  processing: boolean;
  agentQuestion: any | null;
}

const AGENT_TRIGGER_KEYWORDS = /解密|转换|转码|转成|批量|处理|压缩|kgma|kgg|mflac|qmc|kugou|酷狗|无损|flac|mp3|m4a|wav|ogg|音频|音乐文件|文件夹|目录|输出|输出到|提取|提取音频|下载|下载哔哩|bilibili|视频|视频文件/;

export function useAgentSession(input: UseAgentSessionInput) {
  const {
    setPromptText,
    setAgentMessages,
    setToolEvents,
    setStepIndex,
    setProgress,
    setProcessing,
    setTaskStatus,
    setAgentQuestion,
    agentTaskIdRef,
    setAgentTaskIdRef,
    modelConfig,
    permMode,
    showToast,
    promptText,
    processing,
    agentQuestion,
  } = input;

  const _startAgentWorker = useCallback(async (userText: string) => {
    setPromptText("");
    setAgentMessages([{ role: "user", text: userText }]);
    setToolEvents([]);
    setStepIndex(0);
    setProgress(0);
    setProcessing(true);
    setTaskStatus("连接中");

    const modelCfg = {
      model: modelConfig.model,
      base_url: modelConfig.baseUrl,
      api_key: modelConfig.apiKey ?? "",
      temperature: modelConfig.temperature ?? 0.7,
      max_tokens: modelConfig.maxTokens ?? 4096,
    };

    try {
      const result = await window.triMusicAgent.startWorker(
        "agent",
        { message: userText, model_config: modelCfg, max_iterations: 15, permission_mode: permMode },
        permMode as "restricted" | "standard" | "full"
      );
      agentTaskIdRef.current = result.taskId;
      console.info("[useAgentSession] agent worker started:", result.requestId);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Agent 启动失败";
      console.error("[useAgentSession] agent worker failed:", message);
      setProcessing(false);
      setTaskStatus("失败");
      setAgentMessages((prev) => [...prev, { role: "error", text: message }]);
      showToast(message);
    }
  }, [modelConfig, permMode, setPromptText, setAgentMessages, setToolEvents, setStepIndex, setProgress, setProcessing, setTaskStatus, agentTaskIdRef, showToast]);

  const sendPrompt = useCallback(async () => {
    if (!promptText.trim()) { showToast("先告诉 TriMusicAgent 你的想法"); return; }
    const userText = promptText.trim();

    if (AGENT_TRIGGER_KEYWORDS.test(userText)) {
      showToast("检测到音乐处理请求，正在启动 Agent...");
      await _startAgentWorker(userText);
      return;
    }

    console.info("[useAgentSession] send-prompt:", userText.slice(0, 50));
    showToast("非音乐处理请求，请使用普通对话");
  }, [promptText, _startAgentWorker, showToast]);

  const startProcessing = useCallback(async () => {
    if (processing) { showToast("任务已经在处理中"); return; }
    if (!promptText.trim()) { showToast("先告诉 Agent 你想处理什么"); return; }
    await _startAgentWorker(promptText.trim());
  }, [processing, promptText, _startAgentWorker, showToast]);

  const stopProcessing = useCallback(async () => {
    const taskId = agentTaskIdRef.current;
    if (taskId) {
      try {
        await window.triMusicAgent.cancelWorker(taskId);
      } catch { /* ignore cancel errors */ }
      agentTaskIdRef.current = null;
    }
    setProcessing(false);
    setTaskStatus("已停止");
    showToast("任务已停止");
  }, [agentTaskIdRef, setProcessing, setTaskStatus, showToast]);

  const sendSupplement = useCallback(async () => {
    if (!processing) { showToast("任务未在运行"); return; }
    const userText = promptText.trim();
    if (!userText) { showToast("先输入补充内容"); return; }
    const taskId = agentTaskIdRef.current;
    if (!taskId) { showToast("任务未启动"); return; }
    setPromptText("");
    setAgentMessages((prev) => [...prev, { role: "user", text: userText }]);
    try {
      await window.triMusicAgent.sendWorkerSupplement(taskId, userText);
      console.info("[useAgentSession] supplement sent:", userText.slice(0, 80));
    } catch (err) {
      const message = err instanceof Error ? err.message : "补充发送失败";
      setAgentMessages((prev) => [...prev, { role: "error", text: message }]);
      showToast(message);
    }
  }, [processing, promptText, agentTaskIdRef, setPromptText, setAgentMessages, showToast]);

  const answerAgentQuestion = useCallback(async (answer: string) => {
    const q = agentQuestion;
    if (!q) { showToast("当前没有待回答的问题"); return; }
    const taskId = agentTaskIdRef.current;
    if (!taskId) { showToast("任务未启动"); setAgentQuestion(null); return; }
    setAgentQuestion(null);
    setAgentMessages((prev) => [...prev, { role: "user", text: answer }]);
    try {
      await window.triMusicAgent.sendWorkerAnswer(taskId, q.questionId, answer);
      console.info("[useAgentSession] answer sent:", { questionId: q.questionId, answer: answer.slice(0, 80) });
    } catch (err) {
      const message = err instanceof Error ? err.message : "回答发送失败";
      setAgentMessages((prev) => [...prev, { role: "error", text: message }]);
      showToast(message);
    }
  }, [agentQuestion, agentTaskIdRef, setAgentQuestion, setAgentMessages, showToast]);

  return {
    sendPrompt,
    startProcessing,
    stopProcessing,
    sendSupplement,
    answerAgentQuestion,
  };
}
