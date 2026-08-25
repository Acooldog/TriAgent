import { useEffect, useState } from "react";
import type { UseAppStateResult } from "../hooks/useAppState";

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

function SettingsTabContent({
  state,
  autoConfigOpen,
  setAutoConfigOpen,
  setAutoConfigCode,
  autoConfigCode,
  onParseAndApply,
  draftModel,
  saveModelField,
  updateDraftField,
}: {
  state: UseAppStateResult;
  autoConfigOpen: boolean;
  setAutoConfigOpen: (v: boolean) => void;
  setAutoConfigCode: (v: string) => void;
  autoConfigCode: string;
  onParseAndApply: () => void;
  draftModel: typeof state.modelConfig;
  saveModelField: (patch: Partial<typeof state.modelConfig>) => void;
  updateDraftField: (patch: Partial<typeof state.modelConfig>) => void;
}) {
  const { settingsTab, networkEnabled, toggleNetwork, mode, selectMode, modelConfig, updateModelConfig, autoCompression, setAutoCompression, compressionThreshold, setCompressionThreshold, setModal, navigateTo, workspaceRoot, showToast } = state;

  if (settingsTab === "permission") {
    return (
      <div className="setting-block">
        <h3>权限模式</h3>
        <p>应用可以管理员启动，但 TriMusicAgent 的操作仍由权限模式控制。</p>
        <div className="mode-cards">
          {(["受限", "标准", "完全访问"] as const).map((m) => {
            const map: Record<string, "restricted" | "standard" | "full"> = { "受限": "restricted", "标准": "standard", "完全访问": "full" };
            const desc = m === "受限" ? "只检测和提示敏感操作" : m === "标准" ? "敏感操作需要你的审批" : "允许范围内自动执行";
            return (
              <button key={m} className={`mode-card ${mode === m ? "selected" : ""}`} onClick={() => selectMode(map[m])}>
                <b>{m}</b><small>{desc}</small>
              </button>
            );
          })}
        </div>
        <label className="setting-switch">
          <span>联网访问</span>
          <input type="checkbox" checked={networkEnabled} onChange={toggleNetwork} />
          <i />
        </label>
        <label className="setting-switch"><span>默认管理员启动</span><input type="checkbox" defaultChecked /><i /></label>
      </div>
    );
  }

  if (settingsTab === "limits") {
    return (
      <div className="setting-block">
        <h3>任务限制</h3>
        <div className="field-grid">
          <label>单步骤最大重试次数<input defaultValue="2" /></label>
          <label>单任务最大模型轮数<input defaultValue="8" /></label>
          <label>单任务最大工具调用数<input defaultValue="16" /></label>
          <label>单任务总超时<input defaultValue="15 分钟" /></label>
        </div>
        <label className="setting-switch">
          <span>自动压缩</span>
          <input type="checkbox" checked={autoCompression} onChange={(e) => setAutoCompression(e.target.checked)} />
          <i />
        </label>
        <div className="field-grid">
          <label>上下文压缩阈值（%）
            <input
              type="number"
              min={50}
              max={95}
              value={compressionThreshold}
              onChange={(e) => setCompressionThreshold(Math.max(50, Math.min(95, Number(e.target.value) || 80)))}
            />
            <small>达到此比例后，保留最近消息并压缩较早上下文。</small>
          </label>
        </div>
        <div className="notice amber">超过限制后立即停止任务，避免无限重试和继续消耗 Token。</div>
      </div>
    );
  }

  if (settingsTab === "tools") {
    const tools: [string, string][] = [["音乐格式识别", "v1.0.0"], ["QQ 音乐解密器", "v2.1"], ["网易云 NCM", "v1.4.2"], ["FFmpeg", "7.0.2"]];
    return (
      <div className="setting-block">
        <h3>工具管理</h3>
        <p>只有协议版本兼容、Schema 校验通过的工具才允许热插拔。</p>
        <div className="tool-table">
          {tools.map(([name, version]) => (
            <div key={name}>
              <b>{name}</b><code>{version}</code><span>已启用</span>
              <button onClick={() => showToast("已刷新协议")}>检查协议</button>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (settingsTab === "data") {
    return (
      <div className="setting-block">
        <h3>数据与会话</h3>
        <label>工作数据根目录<input value={workspaceRoot} readOnly /></label>
        <div className="path-preview">session/2026/08/22/&lt;session-id&gt;/</div>
        <label className="setting-switch"><span>保留原始会话</span><input type="checkbox" defaultChecked /><i /></label>
        <label className="setting-switch"><span>接近上下文边界时提醒压缩</span><input type="checkbox" defaultChecked /><i /></label>
        <button className="secondary" onClick={() => navigateTo("recovery")}>打开会话压缩</button>
      </div>
    );
  }

  return (
    <div className="setting-block">
      <h3>模型设置</h3>
      <div className="setting-actions">
        <button className="secondary" onClick={() => setAutoConfigOpen(true)}>从 Python 代码自动配置</button>
      </div>
      <div className="field-grid">
        <label>模型提供商<select><option>OpenAI-compatible</option><option>自定义接口</option></select></label>
        <label>模型名称
          <input
            value={draftModel.model}
            onChange={(e) => updateDraftField({ model: e.target.value })}
            onBlur={(e) => saveModelField({ model: (e.target as HTMLInputElement).value })}
          />
        </label>
        <label>API Base URL
          <input
            value={draftModel.baseUrl}
            onChange={(e) => updateDraftField({ baseUrl: e.target.value })}
            onBlur={(e) => saveModelField({ baseUrl: (e.target as HTMLInputElement).value })}
          />
        </label>
        <label>请求超时（秒）
          <input
            type="number"
            value={Math.round((draftModel.connectTimeoutMs ?? 60000) / 1000)}
            onChange={(e) => updateDraftField({ connectTimeoutMs: Number(e.target.value) * 1000 })}
            onBlur={(e) => saveModelField({ connectTimeoutMs: Number((e.target as HTMLInputElement).value) * 1000 })}
          />
        </label>
      </div>
      <div className="field-grid real-model-fields">
        <label>API Key
          <input
            type="password"
            value={draftModel.apiKey ?? ""}
            onChange={(e) => updateDraftField({ apiKey: e.target.value })}
            onBlur={(e) => saveModelField({ apiKey: (e.target as HTMLInputElement).value })}
            autoComplete="off"
          />
        </label>
        <label>思考模式
          <select
            value={draftModel.thinking}
            onChange={(e) => { const v = e.target.value as "enabled" | "disabled"; updateDraftField({ thinking: v }); saveModelField({ thinking: v }); }}
          >
            <option value="enabled">开启深度思考</option>
            <option value="disabled">关闭深度思考</option>
          </select>
        </label>
        <label>最大 Token
          <input
            type="number"
            min="1"
            step="1"
            value={draftModel.maxTokens}
            onChange={(e) => updateDraftField({ maxTokens: Math.max(1, Number(e.target.value) || 4096) })}
            onBlur={(e) => saveModelField({ maxTokens: Math.max(1, Number((e.target as HTMLInputElement).value) || 4096) })}
          />
        </label>
        <label>Temperature
          <input
            type="number"
            min="0"
            max="2"
            step="0.1"
            value={draftModel.temperature}
            onChange={(e) => updateDraftField({ temperature: Math.max(0, Math.min(2, Number(e.target.value) || 0.6)) })}
            onBlur={(e) => saveModelField({ temperature: Math.max(0, Math.min(2, Number((e.target as HTMLInputElement).value) || 0.6)) })}
          />
        </label>
      </div>
      <button className="secondary" onClick={() => state.testModelConnection()}>测试连接</button>
      <button className="secondary" onClick={() => state.resetModel()}>恢复推荐</button>

      {autoConfigOpen && (
        <div className="modal-backdrop">
          <section className="approval-modal">
            <div className="modal-title">
              <span className="status-icon">⚙</span>
              <h3>从 Python 代码自动配置</h3>
              <button onClick={() => setAutoConfigOpen(false)}>关闭</button>
            </div>
            <p className="auto-config-hint">粘贴官方 Python SDK 示例代码，自动提取模型名称、API Key、思考模式、Token 上限和 Temperature。未提供的字段保持不变。</p>
            <textarea
              className="auto-config-textarea"
              spellCheck={false}
              placeholder={'例如：\nclient = ZhipuAiClient(api_key="YOUR_API_KEY")\nresponse = client.chat.completions.create(\n    model="glm-4.5",\n    thinking={"type": "enabled"},\n    max_tokens=4096,\n    temperature=0.6\n)'}
              value={autoConfigCode}
              onChange={(e) => setAutoConfigCode(e.target.value)}
            />
            <div className="button-row">
              <button className="secondary" onClick={() => { setAutoConfigCode(""); }}>清空</button>
              <button className="primary" onClick={onParseAndApply}>解析并填写</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
