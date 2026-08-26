import { useCallback } from "react";
import type { PermissionMode } from "../../../application/toolProtocol";
import type { ModelConfig } from "../../../application/modelProtocol";

export interface UseSettingsControlResult {
  networkEnabled: boolean;
  setNetworkEnabledState: (v: boolean) => void;
  mode: string;
  modelConfig: ModelConfig;
  setModelConfig: (c: ModelConfig) => void;
  toggleNetwork: () => Promise<void>;
  selectMode: (modeKey: PermissionMode) => Promise<void>;
  saveConfig: () => Promise<void>;
  testModelConnection: () => Promise<void>;
  resetModel: () => Promise<void>;
}

const PERMISSION_MODE_MAP: Record<PermissionMode, string> = { restricted: "受限", standard: "标准", full: "完全访问" };

export function useSettingsControl(
  settings: ReturnType<typeof import("../useAppSettings").useAppSettings>["settings"],
  networkEnabled: boolean,
  setNetworkEnabledState: (v: boolean) => void,
  mode: string,
  modelConfig: ModelConfig,
  setModelConfig: (c: ModelConfig) => void,
  updateNetworkEnabled: (v: boolean) => Promise<void>,
  updatePermissionMode: (m: PermissionMode) => Promise<void>,
  saveModelConfig: (c: ModelConfig) => Promise<void>,
  showToast: (msg: string) => void,
  addNotice: (text: string) => void,
  setLlmMessages: React.Dispatch<React.SetStateAction<import("./useAppState").LlmMessage[]>>,
  setLlmStreaming: React.Dispatch<React.SetStateAction<{ text: string; index: number } | null>>,
  setLlmThinking: React.Dispatch<React.SetStateAction<boolean>>,
  setLlmTested: React.Dispatch<React.SetStateAction<boolean>>,
  setLlmTextRef: React.Dispatch<React.SetStateAction<string>>,
  setLlmReasoningRef: React.Dispatch<React.SetStateAction<string>>,
  llmRequestIdRef: React.MutableRefObject<string | null>,
  setLlmRequestIdRef: (ref: React.MutableRefObject<string | null>) => void,
) {
  const toggleNetwork = useCallback(async () => {
    const newValue = !networkEnabled;
    console.info("[useSettingsControl] toggle-network:", newValue);
    setNetworkEnabledState(newValue);
    try {
      await updateNetworkEnabled(newValue);
      addNotice(newValue ? "已开启联网" : "已关闭联网");
    } catch {
      setNetworkEnabledState(!newValue);
      showToast("联网设置保存失败");
    }
  }, [networkEnabled, updateNetworkEnabled, setNetworkEnabledState, showToast, addNotice]);

  const selectMode = useCallback(async (modeKey: PermissionMode) => {
    const label = PERMISSION_MODE_MAP[modeKey];
    console.info("[useSettingsControl] select-mode:", label);
    try {
      await updatePermissionMode(modeKey);
      addNotice(`已切换为${label}模式`);
    } catch {
      showToast("权限模式保存失败");
    }
  }, [updatePermissionMode, showToast, addNotice]);

  const saveConfig = useCallback(async () => {
    console.info("[useSettingsControl] save-config");
    await saveModelConfig(modelConfig);
    showToast("设置已保存");
  }, [modelConfig, saveModelConfig, showToast]);

  const testModelConnection = useCallback(async () => {
    if (!modelConfig.apiKey) { showToast("请先填写 API Key"); return; }
    if (!modelConfig.baseUrl) { showToast("请先配置 API Base URL"); return; }
    addNotice("正在测试模型连接……");
    setLlmTextRef("");
    setLlmReasoningRef("");
    setLlmStreaming({ text: "", index: 0 });
    setLlmThinking(false);
    try {
      const result = await window.triMusicAgent.startModel(
        modelConfig,
        [{ role: "user" as const, content: "请只回复：连接成功" }],
        "standard",
        networkEnabled
      );
      console.info("[useSettingsControl] model test started:", result.requestId);
      llmRequestIdRef.current = result.requestId;
    } catch (err) {
      const message = err instanceof Error ? err.message : "模型连接失败";
      console.error("[useSettingsControl] model test failed:", message);
      setLlmStreaming(null);
      setLlmMessages((prev) => [...prev.filter((m) => m.role !== "notice"), { role: "error", text: message }]);
      showToast(message);
    }
  }, [modelConfig, networkEnabled, showToast, addNotice, setLlmTextRef, setLlmReasoningRef, setLlmStreaming, setLlmThinking, setLlmMessages, llmRequestIdRef]);

  const resetModel = useCallback(async () => {
    const defaultModel = { ...modelConfig, model: "DeepSeek-R1" };
    setModelConfig(defaultModel);
    setLlmTested(false);
    await saveModelConfig(defaultModel);
    showToast("已恢复推荐模型配置");
  }, [modelConfig, setModelConfig, saveModelConfig, showToast, setLlmTested]);

  return {
    toggleNetwork,
    selectMode,
    saveConfig,
    testModelConnection,
    resetModel,
  };
}
