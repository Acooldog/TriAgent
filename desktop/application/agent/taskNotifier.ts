import { app, Notification, shell } from "electron";
import { debugError, debugInfo } from "../debugLogger";

const APP_USER_MODEL_ID = "com.trimusicagent.app";

let appUserModelIdConfigured = false;

export function configureAppUserModelId(): void {
  if (appUserModelIdConfigured) return;
  try {
    if (typeof app.setAppUserModelId === "function") {
      app.setAppUserModelId(APP_USER_MODEL_ID);
      debugInfo("notifier", "set-app-user-model-id", { id: APP_USER_MODEL_ID });
    }
    appUserModelIdConfigured = true;
  } catch (error) {
    debugError("notifier", "set-app-user-model-id-failed", error instanceof Error ? error : undefined);
  }
}

export type TaskOutcome = "completed" | "failed" | "cancelled" | "timeout";

interface NotificationContent {
  title: string;
  body: string;
}

function buildContent(outcome: TaskOutcome, summary?: string): NotificationContent {
  const preview = (summary ?? "").trim().slice(0, 120);
  switch (outcome) {
    case "completed":
      return { title: "TriMusicAgent 任务完成", body: preview || "Agent 已完成全部任务，请回应用主界面查看结果。" };
    case "failed":
      return { title: "TriMusicAgent 任务失败", body: preview || "Agent 执行中遇到无法恢复的异常，请查看详情。" };
    case "cancelled":
      return { title: "TriMusicAgent 任务已停止", body: preview || "任务已被取消。" };
    case "timeout":
      return { title: "TriMusicAgent 任务超时", body: preview || "Agent 执行超时，请重试。" };
  }
}

export function notifyTaskOutcome(outcome: TaskOutcome, summary?: string): void {
  configureAppUserModelId();
  const { title, body } = buildContent(outcome, summary);

  try {
    if (!Notification.isSupported()) {
      debugInfo("notifier", "not-supported", { outcome });
      shell.beep();
      return;
    }
    const notification = new Notification({ title, body, silent: false });
    notification.on("click", () => {
      debugInfo("notifier", "click", { outcome });
    });
    notification.show();
    debugInfo("notifier", "shown", { outcome, title });
  } catch (error) {
    debugError("notifier", "show-failed", error instanceof Error ? error : undefined, { outcome });
  }

  // 兜底发声：确保即使系统通知静音也能听到提示音
  try {
    shell.beep();
  } catch (error) {
    debugError("notifier", "beep-failed", error instanceof Error ? error : undefined);
  }
}
