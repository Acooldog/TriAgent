import { useEffect, useState, type ReactElement } from "react";
import type { WorkspaceState } from "../../application/workspaceService";
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

  useEffect(() => {
    let active = true;
    const unsubscribe = window.triMusicAgent.onInitializationState((nextState) => {
      if (active) setState(nextState);
    });
    void window.triMusicAgent.getInitializationState().then((nextState) => {
      if (active) setState(nextState);
    });
    return () => {
      active = false;
      unsubscribe();
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
