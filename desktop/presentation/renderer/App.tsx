import { useEffect, useState, type ReactElement } from "react";
import type { WorkspaceState } from "../../application/workspaceService";
import type { WorkerEvent } from "../../application/workerProtocol";
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
    void window.triMusicAgent.getInitializationState().then((nextState) => {
      if (active) setState(nextState);
    });
    return () => {
      active = false;
      unsubscribe();
      unsubscribeWorker();
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
