import type { BatchProgressState } from "../../hooks/useAppState/useAppState.types";

interface BatchProgressCardProps {
  progress: BatchProgressState;
}

const PLATFORM_LABELS: Record<string, string> = {
  kugou: "酷狗",
  kuwo: "酷我",
  netease: "网易云",
  qq: "QQ音乐",
  generic: "通用",
};

const STAGE_LABELS: Record<string, string> = {
  scanning: "扫描文件中",
  decrypting: "解密中",
  transcoding: "转码中",
  verifying: "校验中",
  done: "已完成",
  failed: "失败",
};

function stageIcon(stage?: string) {
  if (stage === "done") return "✅";
  if (stage === "failed") return "❌";
  if (stage === "transcoding") return "🎵";
  return "🔓";
}

export function BatchProgressCard({ progress }: BatchProgressCardProps) {
  if (!progress.active && !progress.finished) return null;

  const platformLabel = PLATFORM_LABELS[progress.platformId ?? "generic"] ?? progress.platformId ?? "";
  const stageLabel = STAGE_LABELS[progress.currentStage ?? ""] ?? "处理中";
  const isDone = progress.finished;
  const overallPct = progress.totalCount > 0 ? Math.round((progress.currentIndex / progress.totalCount) * 100) : 0;
  const filePct = progress.currentProgress;

  const headerText = isDone
    ? `${platformLabel}解密完成`
    : progress.currentFile
      ? `${platformLabel}解密中 · ${progress.currentFile}`
      : `${platformLabel}解密准备中`;

  return (
    <div
      className={`batch-progress-card ${isDone ? "finished" : ""} ${progress.finalStatus === "failed" ? "failed" : ""}`}
      style={{
        background: isDone ? "linear-gradient(135deg, rgba(34,197,94,0.15), rgba(34,197,94,0.05))" : "linear-gradient(135deg, rgba(99,102,241,0.12), rgba(99,102,241,0.04))",
        borderLeft: `4px solid ${progress.finalStatus === "failed" ? "#ef4444" : isDone ? "#22c55e" : "#6366f1"}`,
        borderRadius: 10,
        padding: "14px 16px",
        margin: "10px 0",
        fontFamily: "var(--font-ui, system-ui, sans-serif)",
        fontSize: 13,
        animation: isDone ? "batchFinish 0.6s ease-out" : "batchPulse 2s ease-in-out infinite",
      }}
    >
      <style>{`
        @keyframes batchPulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(99,102,241,0.2); }
          50% { box-shadow: 0 0 0 8px rgba(99,102,241,0); }
        }
        @keyframes batchFinish {
          0% { transform: scale(1); }
          40% { transform: scale(1.02); }
          100% { transform: scale(1); box-shadow: 0 4px 20px rgba(34,197,94,0.25); }
        }
        .batch-progress-bar {
          height: 6px; border-radius: 3px; background: rgba(255,255,255,0.1); overflow: hidden;
        }
        .batch-progress-bar > div {
          height: 100%; border-radius: 3px; transition: width 0.35s ease-out;
        }
      `}</style>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 18 }}>{stageIcon(progress.currentStage)}</span>
        <span style={{ fontWeight: 600, fontSize: 14, flex: 1 }}>{headerText}</span>
        {isDone && progress.finalMessage && (
          <span style={{ fontSize: 12, opacity: 0.7 }}>{progress.finalMessage}</span>
        )}
      </div>

      {/* Overall progress */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, fontSize: 12, opacity: 0.8 }}>
          <span>总体进度 · {stageLabel}</span>
          <span>{progress.currentIndex}/{progress.totalCount}</span>
        </div>
        <div className="batch-progress-bar">
          <div style={{
            width: `${overallPct}%`,
            background: isDone
              ? "linear-gradient(90deg, #22c55e, #16a34a)"
              : progress.finalStatus === "failed"
                ? "linear-gradient(90deg, #ef4444, #dc2626)"
                : "linear-gradient(90deg, #6366f1, #8b5cf6)",
          }} />
        </div>
      </div>

      {/* Single-file progress */}
      {!isDone && progress.currentFile && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, fontSize: 12, opacity: 0.8 }}>
            <span>当前文件</span>
            <span>{progress.currentProgress}%</span>
          </div>
          <div className="batch-progress-bar">
            <div style={{
              width: `${filePct}%`,
              background: "linear-gradient(90deg, #f59e0b, #d97706)",
            }} />
          </div>
        </div>
      )}

      {/* Stats */}
      <div style={{ display: "flex", gap: 16, fontSize: 12, opacity: 0.85 }}>
        <span style={{ color: "#22c55e" }}>成功 {progress.successCount}</span>
        {progress.skippedCount > 0 && <span style={{ color: "#94a3b8" }}>跳过 {progress.skippedCount}</span>}
        {progress.failedCount > 0 && <span style={{ color: "#ef4444" }}>失败 {progress.failedCount}</span>}
      </div>

      {/* Input/Output hint (only when active + not done) */}
      {!isDone && progress.inputPath && (
        <div style={{ marginTop: 8, fontSize: 11, opacity: 0.5, wordBreak: "break-all" }}>
          📂 {progress.inputPath}
          {progress.outputDir && ` → ${progress.outputDir}`}
        </div>
      )}
    </div>
  );
}
