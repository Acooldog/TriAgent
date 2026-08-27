/** Batch event handlers — decrypt/transcode progress pipeline events.
 *
 * Decoupled from the main event dispatcher so that the giant switch in
 * useAppState.events.ts stays focused on agent-lifecycle events.
 */
import type { Dispatch, SetStateAction } from "react";
import type { BatchProgressState } from "../useAppState.types";

export interface BatchEventDeps {
  setBatchProgress: Dispatch<SetStateAction<BatchProgressState>>;
}

export function handleBatchEvent(
  eventType: string,
  payload: Record<string, unknown>,
  deps: BatchEventDeps,
): void {
  switch (eventType) {
    case "batch_started": {
      const platformId = String(payload.platform_id ?? "");
      const kind = (payload.kind === "transcode" ? "transcode" : "decrypt") as "decrypt" | "transcode" | "copy" | "generic";
      deps.setBatchProgress({
        active: true, kind,
        platformId: platformId || undefined,
        inputPath: String(payload.input_path ?? ""),
        outputDir: String(payload.output_dir ?? ""),
        totalCount: Number(payload.candidate_count ?? 0),
        currentIndex: 0,
        currentProgress: 0,
        currentStage: "scanning",
        successCount: 0, skippedCount: 0, failedCount: 0,
        finished: false,
      });
      break;
    }
    case "file_started": {
      const idx = Number(payload.index ?? 0);
      const total = Number(payload.total ?? 1);
      deps.setBatchProgress((prev) => ({
        ...prev,
        active: true,
        currentIndex: idx,
        currentProgress: 0,
        currentFile: String(payload.input_path ?? "").split(/[\\/]/).pop() || "",
        currentStage: prev.kind === "transcode" ? "transcoding" : "decrypting",
        totalCount: total || prev.totalCount,
      }));
      break;
    }
    case "batch_transcode_progress": {
      const idx = Number(payload.index ?? 0);
      const total = Number(payload.total ?? 1);
      deps.setBatchProgress((prev) => ({
        ...prev,
        active: true,
        currentIndex: idx,
        currentProgress: 60, // transcode mid-point heuristic
        currentFile: String(payload.input_path ?? "").split(/[\\/]/).pop() || prev.currentFile,
        currentStage: "transcoding",
        totalCount: total || prev.totalCount,
      }));
      break;
    }
    case "file_finished": {
      const result = String(payload.result ?? "ok");
      deps.setBatchProgress((prev) => {
        const success = prev.successCount + (result === "ok" ? 1 : 0);
        const skipped = prev.skippedCount + (result === "already_decrypted" || result === "skipped" ? 1 : 0);
        const failed = prev.failedCount + (result === "failed" ? 1 : 0);
        return {
          ...prev,
          active: true,
          currentProgress: 100,
          currentStage: "verifying",
          successCount: success, skippedCount: skipped, failedCount: failed,
        };
      });
      break;
    }
    case "batch_finished": {
      const resultCode = String(payload.result_code ?? "");
      const successCount = Number(payload.success_count ?? 0);
      const failedCount = Number(payload.failed_count ?? 0);
      const skippedCount = Number(payload.skipped_count ?? 0);
      const kind = (payload.kind === "transcode" ? "transcode" : "decrypt") as "decrypt" | "transcode" | "copy" | "generic";
      const opLabel = kind === "transcode" ? "转换" : "解密";
      deps.setBatchProgress({
        active: true, kind,
        platformId: String(payload.platform_id ?? undefined),
        totalCount: Number(payload.candidate_count ?? 0),
        currentIndex: Number(payload.candidate_count ?? 0),
        currentProgress: 100,
        currentStage: "done",
        currentFile: undefined,
        successCount, skippedCount, failedCount,
        finished: true,
        finalStatus: resultCode === "ok" || (failedCount === 0 && successCount > 0) ? "completed" : "failed",
        finalMessage: `${opLabel}完成：成功 ${successCount}，跳过 ${skippedCount}，失败 ${failedCount}`,
      });
      break;
    }
  }
}
