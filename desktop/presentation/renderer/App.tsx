import { useEffect, useState, type ReactElement } from "react";
import type { ModelConfig, ModelEvent } from "../../application/modelProtocol";
import type { WorkerEvent } from "../../application/workerProtocol";
import type { WorkspaceState } from "../../application/workspaceService";
import type { PermissionMode } from "../../application/toolProtocol";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import { ProviderPanel } from "./ProviderPanel";
import "./styles.css";

const EMPTY_STATE: WorkspaceState = {
  status: "needs-workspace",
  message: "正在读取工作区状态。",
  workspaceRoot: null,
  sessions: [],
  selectedSessionId: null,
  selectedSession: null,
};

export function App(): ReactElement {
  const [state, setState] = useState<WorkspaceState>(EMPTY_STATE);
  const [busy, setBusy] = useState(false);
  const [workerEvents, setWorkerEvents] = useState<WorkerEvent[]>([]);
  const [workerTaskId, setWorkerTaskId] = useState<string | null>(null);
  const [workerBusy, setWorkerBusy] = useState(false);
  const [modelConfig, setModelConfig] = useState<ModelConfig>({ baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.5", apiKey: "", thinking: "enabled", maxTokens: 4096, temperature: 0.6 });
  const [modelPrompt, setModelPrompt] = useState("请用一句话介绍你自己。");
  const [modelEvents, setModelEvents] = useState<ModelEvent[]>([]);
  const [modelRequestId, setModelRequestId] = useState<string | null>(null);
  const [modelBusy, setModelBusy] = useState(false);
  const [compressionMessage, setCompressionMessage] = useState("");
  const [persistenceError, setPersistenceError] = useState("");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("standard");
  const [networkEnabled, setNetworkEnabled] = useState(false);

  useEffect(() => {
    let active = true;
    const unsubscribeState = window.triMusicAgent.onInitializationState((next) => { if (active) setState(next); });
    const unsubscribeWorker = window.triMusicAgent.onWorkerEvent((event) => {
      if (!active) return;
      setWorkerEvents((current) => [...current.slice(-19), event]);
      if (event.event_type === "worker_finished" || event.status === "failed" || event.status === "cancelled") {
        setWorkerTaskId(null);
        setWorkerBusy(false);
      }
    });
    const unsubscribeModel = window.triMusicAgent.onModelEvent(({ event }) => {
      if (!active) return;
      setModelEvents((current) => [...current.slice(-39), event]);
      if (event.type === "response_completed" || event.type === "error") {
        setModelBusy(false);
        setModelRequestId(null);
      }
    });
    const unsubscribePersistence = window.triMusicAgent.onPersistenceError((error) => {
      if (active) setPersistenceError(`${error.label}：${error.message}`);
    });
    void window.triMusicAgent.getInitializationState().then((next) => { if (active) setState(next); });
    return () => {
      active = false;
      unsubscribeState();
      unsubscribeWorker();
      unsubscribeModel();
      unsubscribePersistence();
    };
  }, []);

  const runAction = async (action: () => Promise<WorkspaceState>) => {
    setBusy(true);
    try { setState(await action()); } finally { setBusy(false); }
  };

  const compress = () => {
    setCompressionMessage("");
    void window.triMusicAgent.compressSession({ thresholdTokens: 1200, preserveRecentMessages: 4, markdownThresholdTokens: 2400, markdownMaxRatio: 0.8, writeMarkdown: true })
      .then((result) => setCompressionMessage(result.fallback ? "压缩失败，已继续使用原始会话。" : result.compressed ? `上下文已从约 ${result.estimatedTokensBefore} Token 压缩至 ${result.estimatedTokensAfter} Token。` : "尚未达到压缩阈值。"))
      .catch((error) => setCompressionMessage(error instanceof Error ? error.message : "上下文压缩失败。"));
  };

  return <main className="shell">
    <header className="topbar">
      <div><p className="eyebrow">TRIMUSICAGENT MVP</p><h1>工作区与会话</h1></div>
      <span className={`status status-${state.status}`}>{statusLabel(state.status)}</span>
    </header>

    <section className="workspace-panel">
      <div className="panel-heading">
        <div><h2>工作数据根目录</h2><p>运行数据只写入你选择的非 C 盘可写目录。</p></div>
        <button type="button" onClick={() => void runAction(() => window.triMusicAgent.chooseWorkspaceRoot())} disabled={busy}>选择目录</button>
      </div>
      <code className="workspace-path">{state.workspaceRoot ?? "尚未选择"}</code>
      <p className={`message message-${state.status}`}>{state.message}</p>
    </section>

    <section className="sessions-panel permission-panel">
      <div className="panel-heading"><div><h2>权限与联网</h2><p>标准模式会在敏感操作前请求批准；联网按会话默认关闭。</p></div></div>
      <div className="permission-options" role="radiogroup" aria-label="权限模式">{(["restricted", "standard", "full"] as PermissionMode[]).map((mode) => <label className={permissionMode === mode ? "selected" : ""} key={mode}><input type="radio" name="permission-mode" value={mode} checked={permissionMode === mode} onChange={() => setPermissionMode(mode)} /><span>{permissionLabel(mode)}</span></label>)}</div>
      <label className="network-toggle"><input type="checkbox" checked={networkEnabled} onChange={(event) => setNetworkEnabled(event.target.checked)} /><span>允许当前会话联网</span></label>
    </section>

    <section className="sessions-panel model-panel">
      <div className="panel-heading">
        <div><h2>模型服务</h2><p>测试通用 OpenAI-compatible 流式接口。</p></div>
        <div className="worker-actions">
          <button type="button" onClick={() => { setModelBusy(true); void window.triMusicAgent.startModel(modelConfig, [{ role: "user", content: modelPrompt }], permissionMode, networkEnabled).then(({ requestId }) => setModelRequestId(requestId)).catch(() => setModelBusy(false)); }} disabled={modelBusy || !modelConfig.apiKey || !networkEnabled}>测试模型</button>
          <button type="button" onClick={() => { if (modelRequestId) void window.triMusicAgent.cancelModel(modelRequestId); }} disabled={!modelRequestId}>停止</button>
        </div>
      </div>
      <div className="model-fields">
        <label>Base URL<input value={modelConfig.baseUrl} onChange={(event) => setModelConfig({ ...modelConfig, baseUrl: event.target.value })} /></label>
        <label>模型名<input value={modelConfig.model} onChange={(event) => setModelConfig({ ...modelConfig, model: event.target.value })} /></label>
        <label>API Key<input type="password" value={modelConfig.apiKey ?? ""} onChange={(event) => setModelConfig({ ...modelConfig, apiKey: event.target.value })} autoComplete="off" /></label>
        <label>测试提示词<input value={modelPrompt} onChange={(event) => setModelPrompt(event.target.value)} /></label>
        <label>Thinking<select value={modelConfig.thinking ?? "disabled"} onChange={(event) => setModelConfig({ ...modelConfig, thinking: event.target.value as ModelConfig["thinking"] })}><option value="enabled">enabled</option><option value="disabled">disabled</option></select></label>
        <label>Temperature<input type="number" min="0" max="2" step="0.1" value={modelConfig.temperature ?? 0.6} onChange={(event) => setModelConfig({ ...modelConfig, temperature: Number(event.target.value) })} /></label>
      </div>
      <div className="model-events">{modelEvents.length === 0 ? <div className="empty-state">暂无模型事件。</div> : modelEvents.map((event, index) => <div className="model-event" key={`${event.type}-${index}`}><strong>{event.type}</strong><span>{modelEventText(event)}</span></div>)}</div>
    </section>

    <section className="sessions-panel">
      <div className="panel-heading">
        <div><h2>会话</h2><p>原始消息只追加写入，应用重启后可以恢复。</p></div>
        <div className="worker-actions">
          <button type="button" onClick={() => void runAction(() => window.triMusicAgent.createSession())} disabled={busy || state.status !== "ready"}>新建会话</button>
          <button type="button" onClick={compress} disabled={busy || state.selectedSessionId === null}>压缩上下文</button>
          <button type="button" onClick={() => void runAction(() => window.triMusicAgent.restoreOriginalContext())} disabled={busy || !state.selectedSession?.state.activeCheckpointId}>恢复原始上下文</button>
        </div>
      </div>
      {compressionMessage ? <p className="message message-ready">{compressionMessage}</p> : null}
      {persistenceError ? <p className="message message-error">{persistenceError}</p> : null}
      {state.sessions.length === 0 ? <div className="empty-state">暂无会话。</div> : <div className="session-list">{state.sessions.map((session) => <button className={`session-row ${session.id === state.selectedSessionId ? "selected" : ""}`} key={session.id} type="button" onClick={() => void runAction(() => window.triMusicAgent.selectSession(session.id))} disabled={busy}><span className="session-title">{session.id}</span><span className="session-meta">{session.relativePath} · {formatDate(session.createdAt)}</span></button>)}</div>}
    </section>

    <section className="sessions-panel timeline-panel">
      <div className="panel-heading"><div><h2>操作时间线</h2><p>记录从 events.jsonl 恢复，默认折叠。</p></div><span className="session-meta">{state.selectedSession?.state.status ?? "idle"}</span></div>
      {state.selectedSession?.events.length ? <div className="timeline-list">{state.selectedSession.events.slice().reverse().map((event) => <details className="timeline-entry" key={event.eventId}><summary><strong>{event.eventType}</strong><span>{event.status ?? ""}</span><small>{formatDate(event.emittedAt)}</small></summary><pre>{formatPayload(event.payload)}</pre></details>)}</div> : <div className="empty-state">暂无操作事件。</div>}
    </section>

    <DiagnosticsPanel modelConfig={modelConfig} networkEnabled={networkEnabled} permissionMode={permissionMode} />

    <ProviderPanel permissionMode={permissionMode} />

    <section className="sessions-panel worker-panel">
      <div className="panel-heading"><div><h2>Python worker</h2><p>由主进程桥接结构化 JSON Lines 事件。</p></div><div className="worker-actions"><button type="button" onClick={() => { setWorkerBusy(true); void window.triMusicAgent.startWorker("ping", {}, permissionMode).then(({ taskId }) => setWorkerTaskId(taskId)).catch(() => setWorkerBusy(false)); }} disabled={workerBusy}>测试 worker</button><button type="button" onClick={() => { if (workerTaskId) void window.triMusicAgent.cancelWorker(workerTaskId); }} disabled={workerTaskId === null}>停止</button></div></div>
      {workerEvents.length === 0 ? <div className="empty-state">暂无 worker 事件。</div> : <div className="worker-events">{workerEvents.map((event, index) => <div className="worker-event" key={`${event.request_id}-${index}`}><strong>{event.event_type}</strong><span>{event.status}</span><small>{event.task_id}</small></div>)}</div>}
    </section>
  </main>;
}

function modelEventText(event: ModelEvent): string {
  if (event.type === "text_delta" || event.type === "reasoning_delta") return event.text;
  if (event.type === "error") return event.message;
  if (event.type === "tool_call_accepted") return event.toolCall.name;
  return "";
}

function statusLabel(status: WorkspaceState["status"]): string {
  if (status === "ready") return "已就绪";
  if (status === "error") return "需要处理";
  return "等待选择";
}

function permissionLabel(mode: PermissionMode): string { return mode === "restricted" ? "受限" : mode === "full" ? "完全访问" : "标准"; }

function formatDate(value: string): string { const date = new Date(value); return Number.isNaN(date.valueOf()) ? "时间未知" : date.toLocaleString(); }
function formatPayload(value: Record<string, unknown>): string { try { return JSON.stringify(value, null, 2); } catch { return "内容不可用"; } }
