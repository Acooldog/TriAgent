import { useState } from "react";
import type { AgentSegment } from "../../hooks/useAppState/useAppState.types";

interface Props {
  segments: AgentSegment[];
}

const TYPE_ICON: Record<string, string> = {
  thinking: "🤔",
  tool_call: "⚙️",
  result: "📝",
};

const STATUS_LABEL: Record<string, string> = {
  running: "运行中",
  done: "已完成",
  error: "失败",
};

const TYPE_TITLE: Record<string, string> = {
  thinking: "思考中",
  tool_call: "调用工具中",
  result: "执行结果",
};

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function AgentExecutionSegments({ segments }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  if (segments.length === 0) return null;

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="agent-execution-segments" style={{ margin: "8px 0" }}>
      <style>{`
        .agent-segment {
          border-radius: 8px;
          margin-bottom: 4px;
          overflow: hidden;
          border-left: 2px solid var(--km-label-tertiary, #6b6b6b);
          background: var(--km-bg-tertiary, #292929);
          transition: all 0.3s ease;
        }
        .agent-segment.status-running {
          border-left-color: var(--km-label-secondary, #8f8f8f);
          background: var(--km-bg-secondary, #1f1f1f);
        }
        .agent-segment.status-done {
          border-left-color: #22c55e;
          background: var(--km-bg-tertiary, #292929);
          opacity: 0.85;
        }
        .agent-segment.status-done .agent-segment-title-text {
          color: var(--km-label-secondary, #8f8f8f);
          font-weight: 500;
        }
        .agent-segment.status-error {
          border-left-color: #ef4444;
          background: var(--km-bg-tertiary, #292929);
        }
        .agent-segment-header {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 6px 12px;
          cursor: pointer;
          user-select: none;
          transition: background 0.15s;
          font-size: 12px;
        }
        .agent-segment-header:hover {
          background: var(--km-bg-secondary, #1f1f1f);
        }
        .agent-segment-icon {
          font-size: 14px;
          flex-shrink: 0;
        }
        .agent-segment-title-text {
          flex: 1;
          font-weight: 500;
          color: var(--km-label-primary, #ffffffd6);
          font-size: 12px;
        }
        .agent-segment-status {
          font-size: 11px;
          opacity: 0.55;
          color: var(--km-label-tertiary, #6b6b6b);
        }
        .agent-segment-toggle {
          font-size: 12px;
          transition: transform 0.2s;
          opacity: 0.4;
        }
        .agent-segment-toggle.expanded {
          transform: rotate(90deg);
        }
        .agent-segment-body {
          max-height: 200px;
          overflow-y: auto;
          padding: 0 12px 8px 12px;
          font-size: 12px;
          line-height: 1.5;
          color: var(--km-label-secondary, #ffffff8f);
          white-space: pre-wrap;
          word-break: break-word;
          animation: segmentOpen 0.2s ease-out;
        }
        @keyframes segmentOpen {
          from { opacity: 0; transform: translateY(-4px); max-height: 0; }
          to { opacity: 1; transform: translateY(0); max-height: 200px; }
        }
        .agent-segment.status-running .agent-segment-icon {
          animation: segmentPulse 1.5s ease-in-out infinite;
        }
        @keyframes segmentPulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
      {segments.map((seg) => {
        const isOpen = expanded.has(seg.id);
        const isDone = seg.status === "done";
        const isError = seg.status === "error";
        const duration = seg.finishedAt && seg.createdAt
          ? ` · ${formatDuration(seg.finishedAt - seg.createdAt)}`
          : seg.elapsedSec ? ` · ${seg.elapsedSec.toFixed(1)}s` : "";

        const headerLabel = isDone
          ? (seg.type === "thinking" ? "已思考" : seg.type === "tool_call" ? `已调用 ${seg.toolName ?? ""}` : "已完成")
          : TYPE_TITLE[seg.type] ?? "执行中";

        return (
          <div
            key={seg.id}
            className={`agent-segment status-${seg.status}`}
          >
            <div
              className="agent-segment-header"
              onClick={() => toggle(seg.id)}
            >
              <span className="agent-segment-icon">{TYPE_ICON[seg.type] ?? "•"}</span>
              <span className="agent-segment-title-text">{headerLabel}</span>
              {isDone && <span className="agent-segment-status">{STATUS_LABEL[seg.status]}{duration}</span>}
              {!isDone && !isError && <span className="agent-segment-status">{STATUS_LABEL[seg.status]}</span>}
              {isError && <span className="agent-segment-status" style={{ color: "#ef4444" }}>失败</span>}
              <span className={`agent-segment-toggle ${isOpen ? "expanded" : ""}`}>›</span>
            </div>
            {isOpen && (
              <div className="agent-segment-body">
                {seg.content || "(无详情)"}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
