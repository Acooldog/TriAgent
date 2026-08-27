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

const KIND_LABELS: Record<string, string> = {
  decrypt: "解密",
  transcode: "转换",
  copy: "复制",
  generic: "处理",
};

const STAGE_LABELS: Record<string, string> = {
  scanning: "扫描文件中",
  decrypting: "解密中",
  transcoding: "转换中",
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
  const kindLabel = KIND_LABELS[progress.kind ?? "generic"] ?? "处理";
  const stageLabel = STAGE_LABELS[progress.currentStage ?? ""] ?? "处理中";
  const isDone = progress.finished;
  const hasFailures = progress.failedCount > 0;
  const overallPct = progress.totalCount > 0 ? Math.round((progress.currentIndex / progress.totalCount) * 100) : 0;
  const filePct = progress.currentProgress;

  const headerText = isDone
    ? `${platformLabel}${kindLabel}完成`
    : progress.currentFile
      ? `${platformLabel}${kindLabel}中 · ${progress.currentFile}`
      : `${platformLabel}${kindLabel}准备中`;

  return (
    <div
      className={`batch-progress-card ${isDone ? "finished" : ""} ${hasFailures ? "failed" : ""}`}
      style={{
        background: "var(--km-bg-tertiary, #292929)",
        borderRadius: 10,
        padding: "14px 16px",
        margin: "10px 0",
        fontFamily: "var(--font-ui, system-ui, sans-serif)",
        fontSize: 13,
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 18 }}>{stageIcon(progress.currentStage)}</span>
        <span style={{ fontWeight: 600, fontSize: 14, flex: 1, color: "var(--km-label-primary, #ffffffd6)" }}>{headerText}</span>
        {isDone && progress.finalMessage && (
          <span style={{ fontSize: 12, opacity: 0.6, color: "var(--km-label-secondary, #ffffff8f)" }}>{progress.finalMessage}</span>
        )}
      </div>

      {/* Overall progress */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, fontSize: 12, opacity: 0.8, color: "var(--km-label-secondary, #ffffff8f)" }}>
          <span>总体进度 · {stageLabel}</span>
          <span>{progress.currentIndex}/{progress.totalCount}</span>
        </div>
        <div className="batch-progress-bar" style={{
          height: 6, borderRadius: 3, background: "rgba(255,255,255,0.08)", overflow: "hidden",
        }}>
          <div style={{
            width: `${overallPct}%`,
            height: "100%", borderRadius: 3, transition: "width 0.35s ease-out",
            background: "var(--km-label-primary, #ffffffd6)",
          }} />
        </div>
      </div>

      {/* Single-file progress */}
      {!isDone && progress.currentFile && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, fontSize: 12, opacity: 0.8, color: "var(--km-label-secondary, #ffffff8f)" }}>
            <span>当前文件</span>
            <span>{progress.currentProgress}%</span>
          </div>
          <div style={{
            height: 4, borderRadius: 2, background: "rgba(255,255,255,0.08)", overflow: "hidden",
          }}>
            <div style={{
              width: `${filePct}%`,
              height: "100%", borderRadius: 2, transition: "width 0.35s ease-out",
              background: "var(--km-label-primary, #ffffffd6)",
            }} />
          </div>
        </div>
      )}

      {/* Stats */}
      <div style={{ display: "flex", gap: 16, fontSize: 12 }}>
        <span style={{ color: "#22c55e" }}>成功 {progress.successCount}</span>
        {progress.skippedCount > 0 && <span style={{ color: "var(--km-label-tertiary, #6b6b6b)" }}>跳过 {progress.skippedCount}</span>}
        {progress.failedCount > 0 && <span style={{ color: "#ef4444" }}>失败 {progress.failedCount}</span>}
      </div>

      {/* Input/Output hint (only when active + not done) */}
      {!isDone && progress.inputPath && (
        <div style={{ marginTop: 8, fontSize: 11, opacity: 0.45, wordBreak: "break-all", color: "var(--km-label-tertiary, #6b6b6b)" }}>
          📂 {progress.inputPath}
          {progress.outputDir && ` → ${progress.outputDir}`}
        </div>
      )}
    </div>
  );
}
