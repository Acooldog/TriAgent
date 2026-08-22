import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { ModelService } from "../application/modelService";
import { BUILT_IN_TOOL_MANIFESTS } from "../application/builtInTools";
import type { ChatMessage, ModelConfig, ModelEvent } from "../application/modelProtocol";
import { ToolRegistry, validateManifest, type ToolManifest } from "../application/toolProtocol";
import { WorkspaceService, type WorkspaceState } from "../application/workspaceService";
import { WorkerService } from "../application/workerService";
import type { WorkerEvent, WorkerOperation } from "../application/workerProtocol";
import { PythonWorkerClient } from "../infrastructure/pythonWorker";
import { OpenAiCompatibleClient } from "../infrastructure/openAiCompatibleClient";
import { WindowsRegistrySettingsRepository } from "../infrastructure/registrySettingsRepository";
import { JsonSettingsRepository } from "../infrastructure/settingsRepository";
import { FileSystemWorkspaceRepository } from "../infrastructure/workspaceRepository";

let mainWindow: BrowserWindow | null = null;
let workspaceService: WorkspaceService;
let workerService: WorkerService;
let modelService: ModelService;
let toolRegistry: ToolRegistry;
const activeModelRequests = new Map<string, AbortController>();

function installationDirectory(): string {
  return app.isPackaged ? path.dirname(app.getPath("exe")) : app.getAppPath();
}

function settingsRepository(): WindowsRegistrySettingsRepository | JsonSettingsRepository {
  if (process.platform === "win32") return new WindowsRegistrySettingsRepository();
  return new JsonSettingsRepository(path.join(app.getPath("userData"), "settings.json"));
}

function publishState(state: WorkspaceState): WorkspaceState {
  mainWindow?.webContents.send("app:initialization-state", state);
  return state;
}

function publishWorkerEvent(event: WorkerEvent): WorkerEvent {
  mainWindow?.webContents.send("worker:event", event);
  return event;
}

function publishModelEvent(requestId: string, event: ModelEvent): void {
  mainWindow?.webContents.send("model:event", { requestId, event });
}

function registerIpc(): void {
  ipcMain.handle("app:get-initialization-state", () => workspaceService.getState());
  ipcMain.handle("workspace:choose-root", async () => {
    if (!mainWindow) return workspaceService.getState();
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择工作数据根目录",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return workspaceService.getState();
    }
    return publishState(await workspaceService.chooseWorkspaceRoot(result.filePaths[0]));
  });
  ipcMain.handle("session:create", async () => publishState(await workspaceService.createSession()));
  ipcMain.handle("session:select", async (_event, sessionId: unknown) => {
    if (typeof sessionId !== "string") return workspaceService.getState();
    return publishState(await workspaceService.selectSession(sessionId));
  });
  ipcMain.handle("worker:start", async (_event, operation: unknown, payload: unknown) => {
    if (operation !== "ping" && operation !== "decrypt") throw new Error("worker operation is unsupported");
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new Error("worker payload must be an object");
    let handle;
    try {
      handle = workerService.start(operation as WorkerOperation, payload as Record<string, unknown>, publishWorkerEvent);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : "worker start failed");
    }
    void handle.completion.catch((error: unknown) => {
      const errorCode = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "worker-failed";
      publishWorkerEvent({
        protocol_version: "1",
        request_id: handle.requestId,
        task_id: handle.taskId,
        event_type: "worker_finished",
        status: errorCode === "worker-cancelled" ? "cancelled" : "failed",
        payload: {},
        error: { code: errorCode, message: error instanceof Error ? error.message : "worker failed" },
        emitted_at: new Date().toISOString(),
      });
    });
    return { requestId: handle.requestId, taskId: handle.taskId };
  });
  ipcMain.handle("worker:cancel", (_event, taskId: unknown) => typeof taskId === "string" && workerService.cancel(taskId));
  ipcMain.handle("model:stream", async (_event, config: unknown, messages: unknown, permissionMode: unknown) => {
    if (!isModelConfig(config) || !Array.isArray(messages) || !messages.every(isChatMessage)) throw new Error("模型配置或消息格式无效。");
    if (permissionMode !== "restricted" && permissionMode !== "standard" && permissionMode !== "full") throw new Error("权限模式无效。");
    const requestId = randomUUID();
    const controller = new AbortController();
    activeModelRequests.set(requestId, controller);
    void modelService.stream({ config, messages, permissionMode, allowJsonFallback: true, signal: controller.signal }, (event) => publishModelEvent(requestId, event)).catch((error: unknown) => {
      publishModelEvent(requestId, { type: "error", code: errorCode(error), message: error instanceof Error ? error.message : "模型请求失败。", retryable: Boolean(error && typeof error === "object" && "retryable" in error && error.retryable === true) });
    }).finally(() => activeModelRequests.delete(requestId));
    return { requestId };
  });
  ipcMain.handle("model:cancel", (_event, requestId: unknown) => {
    if (typeof requestId !== "string") return false;
    const controller = activeModelRequests.get(requestId);
    if (!controller) return false;
    controller.abort();
    return true;
  });
  ipcMain.handle("tools:list", () => toolRegistry.list());
  ipcMain.handle("tools:refresh", (_event, manifests: unknown) => {
    if (!Array.isArray(manifests)) throw new Error("工具清单必须是数组。");
    for (const manifest of manifests) validateManifest(manifest as ToolManifest);
    toolRegistry.refresh(manifests as ToolManifest[]);
    return toolRegistry.list();
  });
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    backgroundColor: "#f4f7fb",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  await mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  publishState(workspaceService.getState());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function bootstrap(): Promise<void> {
  workerService = new WorkerService(new PythonWorkerClient({ workerScript: path.join(app.getAppPath(), "desktop", "infrastructure", "publicWorker.py") }));
  toolRegistry = new ToolRegistry();
  toolRegistry.refresh(BUILT_IN_TOOL_MANIFESTS);
  modelService = new ModelService(new OpenAiCompatibleClient(), toolRegistry);
  workspaceService = new WorkspaceService(
    new FileSystemWorkspaceRepository(),
    settingsRepository(),
    installationDirectory(),
  );
  registerIpc();
  await workspaceService.initialize();
  await createWindow();
}

function isModelConfig(value: unknown): value is ModelConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  if (typeof config.baseUrl !== "string" || !config.baseUrl.trim() || typeof config.model !== "string" || !config.model.trim()) return false;
  if (config.apiKey !== undefined && typeof config.apiKey !== "string") return false;
  if (config.headers !== undefined && (typeof config.headers !== "object" || config.headers === null || Array.isArray(config.headers))) return false;
  for (const key of ["maxTokens", "temperature", "connectTimeoutMs", "firstByteTimeoutMs", "readTimeoutMs", "totalTimeoutMs"]) if (config[key] !== undefined && (typeof config[key] !== "number" || !Number.isFinite(config[key]))) return false;
  return config.thinking === undefined || config.thinking === "enabled" || config.thinking === "disabled";
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  return ["system", "user", "assistant", "tool"].includes(String(message.role)) && (typeof message.content === "string" || message.content === null);
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "model-error";
}

void app.whenReady().then(bootstrap).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "应用初始化失败。";
  dialog.showErrorBox("TriMusicAgent 初始化失败", message);
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && workspaceService) void createWindow();
});
