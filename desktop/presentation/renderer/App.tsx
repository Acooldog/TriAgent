import { useEffect, useState, type ReactElement } from "react";
import type { WorkspaceState } from "../../application/workspaceService";
import type { WorkerEvent } from "../../application/workerProtocol";
import type { ModelConfig, ModelEvent } from "../../application/modelProtocol";
import "./styles.css";

const EMPTY_STATE: WorkspaceState = {
  status: "needs-workspace",
  message: "正在读取初始化状态…",
  workspaceRoot: null,
  sessions: [],
  selectedSessionId: null,
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

  useEffect(() => {
    let active = true;
    const unsubscribe = window.triMusicAgent.onInitializationState((nextState) => {
      if (active) setState(nextState);
    });
    const unsubscribeWorker = window.triMusicAgent.onWorkerEvent((event) => {
      if (active) {
        setWorkerEvents((current) => [...current.slice(-19), event]);
        if (event.event_type === "worker_finished" || event.status === "failed" || event.status === "cancelled") {
          setWorkerTaskId(null);
          setWorkerBusy(false);
        }
      }
    });
    const unsubscribeModel = window.triMusicAgent.onModelEvent(({ event }) => {
      if (active) {
        setModelEvents((current) => [...current.slice(-39), event]);
        if (event.type === "response_completed" || event.type === "error") { setModelBusy(false); setModelRequestId(null); }
      }
    });
    void window.triMusicAgent.getInitializationState().then((nextState) => {
      if (active) setState(nextState);
    });
    return () => {
      active = false;
      unsubscribe();
      unsubscribeWorker();
      unsubscribeModel();
    };
  }, []);

  const runAction = async (action: () => Promise<WorkspaceState>) => {
    setBusy(true);
    try {
      setState(await action());
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">TRIMUSICAGENT MVP</p>
          <h1>工作区与会话</h1>
        </div>
        <span className={`status status-${state.status}`}>{statusLabel(state.status)}</span>
      </header>

      <section className="workspace-panel">
        <div className="panel-heading">
          <div>
            <h2>工作数据根目录</h2>
            <p>运行数据只会写入你选择的非 C 盘可写目录。</p>
          </div>
          <button type="button" onClick={() => void runAction(() => window.triMusicAgent.chooseWorkspaceRoot())} disabled={busy}>
            选择目录
          </button>
        </div>
        <code className="workspace-path">{state.workspaceRoot ?? "尚未选择"}</code>
        <p className={`message message-${state.status}`}>{state.message}</p>
      </section>

      <section className="sessions-panel model-panel">
        <div className="panel-heading">
          <div>
            <h2>模型服务</h2>
            <p>通用 OpenAI-compatible 接口；GLM 只是当前示例配置。</p>
          </div>
          <div className="worker-actions">
            <button type="button" onClick={() => { setModelBusy(true); void window.triMusicAgent.startModel(modelConfig, [{ role: "user", content: modelPrompt }], "standard").then(({ requestId }) => setModelRequestId(requestId)).catch(() => setModelBusy(false)); }} disabled={modelBusy || !modelConfig.apiKey}>测试模型</button>
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
        <div className="model-events">{modelEvents.length === 0 ? <div className="empty-state">尚无模型事件。</div> : modelEvents.map((event, index) => <div className="model-event" key={`${event.type}-${index}`}><strong>{event.type}</strong><span>{event.type === "text_delta" || event.type === "reasoning_delta" ? event.text : event.type === "error" ? event.message : event.type === "tool_call_accepted" ? event.toolCall.name : ""}</span></div>)}</div>
      </section>

      <section className="sessions-panel">
        <div className="panel-heading">
          <div>
            <h2>空会话</h2>
            <p>创建一个新的对话，或继续选择已有会话。</p>
          </div>
          <button type="button" onClick={() => void runAction(() => window.triMusicAgent.createSession())} disabled={busy || state.status !== "ready"}>
            新建会话
          </button>
        </div>
        {state.sessions.length === 0 ? (
          <div className="empty-state">暂无会话。选择工作数据根目录后即可新建。</div>
        ) : (
          <div className="session-list">
            {state.sessions.map((session) => (
              <button
                className={`session-row ${session.id === state.selectedSessionId ? "selected" : ""}`}
                key={session.id}
                type="button"
                onClick={() => void runAction(() => window.triMusicAgent.selectSession(session.id))}
                disabled={busy}
              >
                <span className="session-title">{session.id}</span>
                <span className="session-meta">{session.relativePath} · {formatDate(session.createdAt)}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="sessions-panel worker-panel">
        <div className="panel-heading">
          <div>
            <h2>Python worker</h2>
            <p>通过主进程桥接结构化 JSON Lines 事件。</p>
          </div>
          <div className="worker-actions">
            <button type="button" onClick={() => { setWorkerBusy(true); void window.triMusicAgent.startWorker("ping", {}).then(({ taskId }) => setWorkerTaskId(taskId)).catch(() => setWorkerBusy(false)); }} disabled={workerBusy}>测试 worker</button>
            <button type="button" onClick={() => { if (workerTaskId) void window.triMusicAgent.cancelWorker(workerTaskId); }} disabled={workerTaskId === null}>停止</button>
          </div>
        </div>
        {workerEvents.length === 0 ? <div className="empty-state">尚无 worker 事件。</div> : <div className="worker-events">{workerEvents.map((event, index) => <div className="worker-event" key={`${event.request_id}-${index}`}><strong>{event.event_type}</strong><span>{event.status}</span><small>{event.task_id}</small></div>)}</div>}
      </section>
    </main>
  );
}

function statusLabel(status: WorkspaceState["status"]): string {
  if (status === "ready") return "已就绪";
  if (status === "error") return "需要处理";
  return "等待选择";
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "时间未知" : date.toLocaleString();
}
