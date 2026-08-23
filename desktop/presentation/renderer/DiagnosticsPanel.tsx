import { useState, type ReactElement } from "react";
import type { DiagnosticItem, DiagnosticReport } from "../../application/diagnostics";
import type { ModelConfig } from "../../application/modelProtocol";
import type { PermissionMode } from "../../application/toolProtocol";

interface DiagnosticsPanelProps {
  modelConfig: ModelConfig;
  networkEnabled: boolean;
  permissionMode: PermissionMode;
}

export function DiagnosticsPanel(props: DiagnosticsPanelProps): ReactElement {
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const run = async () => {
    setBusy(true); setMessage("");
    try { setReport(await window.triMusicAgent.runDiagnostics({ modelConfig: props.modelConfig, networkEnabled: props.networkEnabled, permissionMode: props.permissionMode })); }
    catch (error) { setMessage(error instanceof Error ? error.message : "健康检查失败。"); }
    finally { setBusy(false); }
  };

  const search = async (item: DiagnosticItem) => {
    setBusy(true); setMessage("");
    try {
      const result = await window.triMusicAgent.searchDiagnosticError({ category: item.category, summary: item.summary }, props.permissionMode, props.networkEnabled);
      setMessage(result.message);
    } catch (error) { setMessage(error instanceof Error ? error.message : "错误搜索失败。"); }
    finally { setBusy(false); }
  };

  return <section className="sessions-panel diagnostics-panel">
    <div className="panel-heading"><div><h2>运行诊断</h2><p>检查关键依赖，并提供脱敏错误与恢复建议。</p></div><button type="button" onClick={() => void run()} disabled={busy}>开始检查</button></div>
    {message ? <p className="message diagnostic-message">{message}</p> : null}
    {report?.logsLocation ? <p className="diagnostic-logs"><strong>日志位置</strong><code>{report.logsLocation}</code></p> : null}
    {!report ? <div className="empty-state">尚未执行健康检查。</div> : <div className="diagnostic-list">{report.items.map((item) => <article className="diagnostic-row" key={item.category}>
      <div className="diagnostic-title"><strong>{item.label}</strong><span className={`diagnostic-status diagnostic-${item.status}`}>{statusLabel(item.status)}</span></div>
      <p>{item.summary}</p><small>恢复建议：{item.recoverySuggestion}</small>
      {item.status === "error" ? <button type="button" onClick={() => void search(item)} disabled={busy || !props.networkEnabled}>搜索此错误</button> : null}
    </article>)}</div>}
  </section>;
}

function statusLabel(status: DiagnosticItem["status"]): string { return status === "healthy" ? "正常" : status === "warning" ? "需注意" : "异常"; }
