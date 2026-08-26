import type { ToolEvent } from "../hooks/useAppState";

const TOOL_ICON_MAP: Record<string, string> = {
  decrypt_kugou: "🔓",
  scan_files: "🔍",
  copy_files: "📦",
  detect_format: "🎵",
  list_directory: "📁",
};

export function ExecutionPanel({
  collapsed,
  onToggle,
  progress,
  toolEvents,
}: {
  collapsed: boolean;
  onToggle: () => void;
  progress: number;
  toolEvents: ToolEvent[];
}) {
  const events = toolEvents.map((event, i) => {
    const icon = TOOL_ICON_MAP[event.name] ?? "⚙️";
    const statusLabel =
      event.status === "done" ? "完成" :
        event.status === "running" ? "执行中" :
          event.status === "error" ? "失败" : "等待";
    const elapsed = event.elapsedSec ? ` (${event.elapsedSec.toFixed(1)}s)` : "";
    const resultPreview = event.toolResult
      ? event.toolResult.slice(0, 80) + (event.toolResult.length > 80 ? "..." : "")
      : "";
    return (
      <div key={`${event.name}-${i}`} className="agent-tool-call">
        <div className={`agent-tool-call-icon ${event.name}`}>{icon}</div>
        <div className="agent-tool-call-info">
          <span className="agent-tool-call-name">{event.name}</span>
          {resultPreview ? (
            <small className="agent-tool-call-detail">{resultPreview}</small>
          ) : null}
        </div>
        <span className={`agent-tool-call-status ${event.status}`}>
          {statusLabel}{elapsed}
        </span>
      </div>
    );
  });

  return (
    <div className={`llm-execution-sticky ${collapsed ? "is-collapsed" : ""}`}>
      <div className="llm-execution-head">
        <strong>Agent 执行过程</strong>
        <span>{progress}%</span>
        <button onClick={onToggle}>{collapsed ? "展开" : "收起"}</button>
      </div>
      <div className="execution-bar"><i style={{ width: `${progress}%` }} /></div>
      {events.length > 0 ? (
        <div className="llm-execution-events">{events}</div>
      ) : null}
    </div>
  );
}
