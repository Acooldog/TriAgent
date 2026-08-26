import type { UseAppStateResult } from "../hooks/useAppState/useAppState";

const DIAGNOSTICS: [string, string, string, string][] = [
  ["QQ 音乐注册表路径", "正常", "已检测", "2026-08-22 14:30"],
  ["QQ 音乐进程", "正常", "未运行", "2026-08-22 14:30"],
  ["网易云音乐路径", "正常", "已检测", "2026-08-22 14:30"],
  ["网易云音乐进程", "提示", "未运行（可选）", "2026-08-22 14:30"],
  ["FFmpeg", "正常", "ffmpeg 7.0.2", "2026-08-22 14:30"],
  ["Python worker", "正常", "待命中", "2026-08-22 14:30"],
  ["解密器", "正常", "版本 v2.1", "2026-08-22 14:30"],
  ["工作数据根目录", "正常", "D:\\TriMusicAgent\\Data", "2026-08-22 14:30"],
];

export function Diagnostics(state: UseAppStateResult) {
  const { showToast, routeBack } = state;
  return (
    <section className="page">
      <div className="page-heading">
        <button className="page-back" onClick={routeBack} aria-label="返回">‹</button>
        <div><h2>诊断中心</h2><p>运行前先确认外部依赖与本地数据边界。</p></div>
        <button className="primary" onClick={() => showToast("诊断完成")}>运行完整诊断</button>
      </div>
      <div className="health-banner">
        <div><span className="health-icon">✓</span><b>系统基本正常</b><small>7 项正常 · 1 项提示</small></div>
        <div><span className="health-icon warn">!</span><b>网易云音乐未运行</b><small>文件级处理不要求客户端进程</small></div>
      </div>
      <div className="diagnostic-card">
        <table>
          <thead><tr><th>检查项目</th><th>状态</th><th>检测结果</th><th>最后检测时间</th><th>操作</th></tr></thead>
          <tbody>
            {DIAGNOSTICS.map(([name, status, result, time]) => (
              <tr key={name}>
                <td><b>{name}</b></td>
                <td>{status === "正常" ? "● 正常" : "● 提示"}</td>
                <td><code>{result}</code></td>
                <td>{time}</td>
                <td><button className="link-button" onClick={() => showToast(`已重新检测 ${name}`)}>重新检测</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="diagnostic-footer">
        <button className="secondary" onClick={() => showToast("诊断报告已准备好")}>导出诊断报告</button>
        <button className="secondary" onClick={() => showToast("错误摘要已复制")}>复制错误摘要</button>
      </div>
    </section>
  );
}

export function Recovery(state: UseAppStateResult) {
  const { compressionDone, compressContext, showToast, routeBack } = state;
  return (
    <section className="page recovery-page">
      <div className="page-heading">
        <button className="page-back" onClick={routeBack} aria-label="返回">‹</button>
        <div><h2>错误恢复与会话压缩</h2><p>处理失败时先止损，再决定重试、换工具或压缩上下文。</p></div>
      </div>
      <div className="recovery-grid">
        <article className="error-card">
          <div className="card-heading"><h3>解密器读取失败</h3><span className="status-icon bad">!</span></div>
          <p>QQ 音乐进程未运行，当前权限模式不允许自动启动。</p>
          <div className="button-row">
            <button className="primary" onClick={() => showToast("已请求审批")}>请求审批</button>
            <button className="secondary" onClick={() => showToast("已重试")}>重试</button>
          </div>
        </article>
        <article className="compression-card">
          <div className="card-heading"><h3>会话压缩</h3><span className="compression-ring">72%</span></div>
          <div className="token-stats">
            <div><b>156</b><small>原始消息数</small></div>
            <div><b>68,432</b><small>当前 Token</small></div>
            <div><b>18,742</b><small>预计压缩后</small></div>
            <div><b>72.6%</b><small>预计节省</small></div>
          </div>
          <label className="setting-switch"><span>生成 Markdown 检查点</span><input type="checkbox" defaultChecked /><i /></label>
          <button className="primary large" onClick={compressContext}>{compressionDone ? "压缩已完成" : "开始压缩"}</button>
        </article>
      </div>
    </section>
  );
}
