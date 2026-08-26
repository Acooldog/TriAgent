import { useEffect, useState } from "react";
import type { UseAppStateResult } from "../hooks/useAppState";
import { SettingsTabContent } from "./SettingsTabContent";

const TABS: [string, string][] = [
  ["model", "模型设置"],
  ["permission", "权限设置"],
  ["limits", "任务限制"],
  ["tools", "工具管理"],
  ["data", "数据与会话"],
];

interface AutoConfigResult {
  model?: string;
  apiKey?: string;
  thinking?: "enabled" | "disabled";
  maxTokens?: number;
  temperature?: number;
}

function parsePythonConfig(code: string): AutoConfigResult {
  const result: AutoConfigResult = {};
  if (!code || typeof code !== "string") return result;

  const apiKeyMatch = code.match(/api[_-]?key\s*=\s*["']([^"']+)["']/i);
  if (apiKeyMatch?.[1] && apiKeyMatch[1] !== "YOUR_API_KEY") {
    result.apiKey = apiKeyMatch[1];
  }

  const modelMatch = code.match(/model\s*=\s*["']([^"']+)["']/);
  if (modelMatch?.[1]) {
    result.model = modelMatch[1];
  }

  const thinkingMatch = code.match(/thinking\s*=\s*\{[^}]*type["']?\s*:\s*["']?(\w+)/i);
  if (thinkingMatch?.[1]) {
    const t = thinkingMatch[1].toLowerCase();
    result.thinking = t === "enabled" || t === "enable" ? "enabled" : "disabled";
  }

  const maxTokensMatch = code.match(/max[_-]?tokens\s*=\s*(\d+)/i);
  if (maxTokensMatch?.[1]) {
    result.maxTokens = Number(maxTokensMatch[1]);
  }

  const tempMatch = code.match(/temperature\s*=\s*([0-9.]+)/i);
  if (tempMatch?.[1]) {
    result.temperature = Number(tempMatch[1]);
  }

  return result;
}

export function Settings(state: UseAppStateResult) {
  const { settingsTab, setSettingsTab, saveConfig, showToast, routeBack } = state;
  const [autoConfigOpen, setAutoConfigOpen] = useState(false);
  const [autoConfigCode, setAutoConfigCode] = useState("");
  const [draftModel, setDraftModel] = useState(state.modelConfig);

  useEffect(() => {
    setDraftModel(state.modelConfig);
  }, [state.modelConfig]);

  const handleParseAndApply = () => {
    const parsed = parsePythonConfig(autoConfigCode);
    const updates: Record<string, unknown> = {};
    if (parsed.model) updates.model = parsed.model;
    if (parsed.apiKey) updates.apiKey = parsed.apiKey;
    if (parsed.thinking) updates.thinking = parsed.thinking;
    if (parsed.maxTokens !== undefined) updates.maxTokens = parsed.maxTokens;
    if (parsed.temperature !== undefined) updates.temperature = parsed.temperature;

    if (Object.keys(updates).length === 0) {
      showToast("未能从代码中解析到有效配置");
      return;
    }

    state.updateModelConfig(updates as Partial<typeof state.modelConfig>);
    setDraftModel((prev) => ({ ...prev, ...updates }));
    console.info("[Settings] auto-config applied:", parsed);
    showToast(`已自动配置：${Object.keys(updates).join("、")}`);
    setAutoConfigOpen(false);
    setAutoConfigCode("");
  };

  const saveModelField = (patch: Partial<typeof state.modelConfig>) => {
    state.updateModelConfig(patch);
  };

  const updateDraftField = (patch: Partial<typeof state.modelConfig>) => {
    setDraftModel((prev) => ({ ...prev, ...patch }));
  };

  return (
    <section className="page settings-page">
      <div className="page-heading">
        <button className="page-back" onClick={routeBack} aria-label="返回">‹</button>
        <div><h2>设置</h2><p>配置模型、权限、工具和会话边界。</p></div>
        <button className="primary" onClick={() => { console.info("[Settings] save"); saveConfig(); }}>保存设置</button>
      </div>
      <div className="settings-layout">
        <aside className="settings-tabs">
          {TABS.map(([id, label]) => (
            <button key={id} className={settingsTab === id ? "active" : ""} onClick={() => setSettingsTab(id)}>{label}<span>›</span></button>
          ))}
        </aside>
        <div className="settings-content">
          <SettingsTabContent
            state={state}
            autoConfigOpen={autoConfigOpen}
            setAutoConfigOpen={setAutoConfigOpen}
            setAutoConfigCode={setAutoConfigCode}
            autoConfigCode={autoConfigCode}
            onParseAndApply={handleParseAndApply}
            draftModel={draftModel}
            saveModelField={saveModelField}
            updateDraftField={updateDraftField}
          />
        </div>
      </div>
    </section>
  );
}
