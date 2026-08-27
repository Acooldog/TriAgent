import type { UseAppStateResult } from "../hooks/useAppState/useAppState";

export function NavPlaceholder() {
  return <aside className="nav-placeholder" aria-hidden="true" />;
}

export function ApprovalModal({ state }: { state: UseAppStateResult }) {
  const { modal, setModal } = state;
  if (modal !== "approval") return null;
  return (
    <div className="modal-backdrop">
      <section className="approval-modal">
        <div className="modal-title">
          <span className="status-icon warn">!</span>
          <h3>需要你的确认</h3>
          <button onClick={() => setModal(null)}>关闭</button>
        </div>
        <div className="approval-risk">标准模式 · 中风险操作</div>
        <dl>
          <dt>操作名称</dt><dd>启动 QQ 音乐并附加解密器</dd>
          <dt>目标路径</dt><dd><code>C:\\Users\\Public\\QQMusic\\QQMusic.exe</code></dd>
        </dl>
        <div className="button-row">
          <button className="primary" onClick={() => { setModal(null); console.info("[ApprovalModal] allow-once"); }}>允许一次</button>
          <button className="secondary" onClick={() => { setModal(null); console.info("[ApprovalModal] allow-task"); }}>允许本任务</button>
          <button className="danger" onClick={() => { setModal(null); console.info("[ApprovalModal] deny"); }}>拒绝</button>
        </div>
      </section>
    </div>
  );
}

export function Toast({ state }: { state: UseAppStateResult }) {
  if (!state.toast) return null;
  return <div className="toast">✓ {state.toast}</div>;
}
