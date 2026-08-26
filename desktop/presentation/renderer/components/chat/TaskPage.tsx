import type { UseAppStateResult, FileItem } from "../hooks/useAppState";

const STEPS = ["格式识别", "调用解密器", "运行 FFmpeg", "校验输出文件", "写入元数据", "生成结果"];

export function TaskPage(state: UseAppStateResult) {
  const { queue, stepIndex, progress, processing, taskStatus, mode, routeBack, showToast, setModal } = state;

  return (
    <section className="page task-page">
      <div className="task-title">
        <button className="page-back" onClick={routeBack} aria-label="返回">‹</button>
        <div>
          <h2>周杰伦音乐批量处理</h2>
          <p>5 个文件 · 当前步骤 {stepIndex + 1} / 6 · 模拟任务</p>
        </div>
        <div className="task-actions">
          <button className="secondary" onClick={() => { setModal("approval"); console.info("[TaskPage] request-approval"); }}>请求审批</button>
          <button className="danger-outline" onClick={() => { console.info("[TaskPage] stop"); }}>停止任务</button>
        </div>
      </div>
      <div className="task-grid">
        <aside className="file-panel">
          <div className="panel-heading"><b>文件列表</b><span>{queue.length}</span></div>
          {queue.map((file, index) => (
            <FileRow key={file.id} file={file} selected={index === 1} />
          ))}
          <button className="add-small" onClick={() => { console.info("[TaskPage] add-file"); }}>添加文件</button>
        </aside>
        <div className="progress-panel">
          <div className="progress-orb">
            <span>{progress}%</span>
            <small>{processing ? "正在处理" : taskStatus}</small>
          </div>
          <h3>{processing ? "正在识别音乐格式" : "任务已暂停"}</h3>
          <p>TriMusicAgent 正在根据文件来源选择合适的工具链。</p>
          <div className="progress-bar"><i style={{ width: `${progress}%` }} /></div>
          <div className="steps">
            {STEPS.map((step, index) => (
              <div key={step} className={`step ${index < stepIndex ? "done" : index === stepIndex ? "current" : ""}`}>
                <span>{index < stepIndex ? "✓" : index + 1}</span>
                <b>{step}</b>
                <small>{index < stepIndex ? "已完成" : index === stepIndex ? "进行中" : "等待"}</small>
              </div>
            ))}
          </div>
          <div className="task-bottom">
            <button className="secondary" onClick={() => showToast("已重试失败项（模拟）")}>重试失败项</button>
            <button className="primary" onClick={() => { console.info("[TaskPage] start"); }}>{processing ? "处理中" : "继续处理"}</button>
          </div>
        </div>
        <aside className="agent-panel">
          <div className="agent-head">
            <span className="agent-avatar">TM</span>
            <div><b>TriMusicAgent</b><small>音乐处理助手 · {mode}模式</small></div>
          </div>
          <div className="event-list">
            <div className="event-heading"><b>操作记录</b><button onClick={() => console.info("[TaskPage] collapse-all")}>全部折叠</button></div>
            {["格式识别", "调用解密器", "运行 FFmpeg", "读取日志", "错误补救"].map((event, index) => (
              <div key={event} className="event">
                <button className="event-toggle">
                  <span>{index < 2 ? "完成" : "待办"}</span>{event}<small>{index < 2 ? "已完成" : "等待"}</small>
                </button>
                <div className={`event-body ${index > 1 ? "is-hidden" : ""}`}>已读取模拟结果，未执行真实工具。</div>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </section>
  );
}

function FileRow({ file, selected }: { file: FileItem; selected: boolean }) {
  return (
    <button className={`task-file ${file.status === "处理中" ? "selected" : ""} ${selected ? "selected" : ""}`}>
      <span className={`cover ${file.cover}`}><i></i><i></i><i></i><i></i></span>
      <span><b>{file.title}</b><small>{file.platform} · {file.size}</small></span>
      <span className={`status-dot ${file.status === "已完成" ? "good" : file.status === "失败" ? "bad" : file.status === "处理中" ? "working" : "idle"}`} />
    </button>
  );
}
