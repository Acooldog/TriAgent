import { app, BrowserWindow, dialog } from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { BUILT_IN_TOOL_MANIFESTS } from "../application/builtInTools";
import { AgentTaskService } from "../application/agentTaskService";
import { type AppSettingsRepository, type AppSettings } from "../application/appSettings";
import { StructuredContextCompressor } from "../application/contextCompression";
import { DiagnosticsService, ErrorSearchService } from "../application/diagnostics";
import { ModelService } from "../application/modelService";
import { PermissionPolicy, type PermissionRequest } from "../application/permissionPolicy";
import { ProviderContractError } from "../application/providerProtocol";
import { ProviderRegistry } from "../application/providerRegistry";
import { ProviderService } from "../application/providerService";
import { ProviderRuntimeService } from "../application/providerRuntimeService";
import { ProviderRuntimeStartPolicy } from "../application/providerRuntimePolicy";
import type { ProviderRuntimeApprovalRequest } from "../application/providerRuntimeProtocol";
import { SessionPersistenceService, type SessionTaskState } from "../application/sessionPersistence";
import { ToolRegistry } from "../application/toolProtocol";
import { WorkspaceService, type SessionInfo, type WorkspaceState, type WorkspaceSettings } from "../application/workspaceService";
import { WorkerService } from "../application/workerService";
import { FileSessionRepository } from "../infrastructure/sessionRepository";
import { AuthorizedMvpProviderGateway } from "../infrastructure/authorizedMvpProviderGateway";
import { FakeMvpProviderRuntimeGateway } from "../infrastructure/fakeMvpProviderRuntimeGateway";
import { DuckDuckGoErrorSearchGateway } from "../infrastructure/duckDuckGoErrorSearch";
import { PythonWorkerClient } from "../infrastructure/pythonWorker";
import { resolveProjectRoot, resolvePythonExecutable, resolveWorkerScript } from "../infrastructure/pythonRuntimePaths";
import { OpenAiCompatibleClient } from "../infrastructure/openAiCompatibleClient";
import { JsonSettingsRepository } from "../infrastructure/settingsRepository";
import { SystemDiagnosticsGateway } from "../infrastructure/systemDiagnostics";
import { FileSystemWorkspaceRepository } from "../infrastructure/workspaceRepository";
import { registerIpc, type IpcContext } from "./ipcHandlers";
import { debugError, debugInfo } from "../application/debugLogger";

let mainWindow: BrowserWindow | null = null;
let workspaceService: WorkspaceService;
let workerService: WorkerService;
let modelService: ModelService;
let toolRegistry: ToolRegistry;
let sessionPersistence: SessionPersistenceService;
let providerService: ProviderService;
let providerRuntimeService: ProviderRuntimeService;
let compressor: StructuredContextCompressor;
let diagnosticsService: DiagnosticsService;
let errorSearchService: ErrorSearchService;
let permissions: PermissionPolicy;
let agentTaskService: AgentTaskService;
let appSettings: AppSettings | null = null;
let settingsRepo: (AppSettingsRepository & WorkspaceSettings) | null = null;
const activeModelRequests = new Map<string, AbortController>();
const activeModelTexts = new Map<string, string>();
const activeTaskContexts = new Map<string, { root: string; session: SessionInfo }>();
const terminalModelRequests = new Set<string>();
let persistenceQueue: Promise<void> = Promise.resolve();

function installationDirectory(): string { return app.isPackaged ? path.dirname(app.getPath("exe")) : app.getAppPath(); }
function settingsRepository(): JsonSettingsRepository { return new JsonSettingsRepository(path.join(app.getPath("userData"), "settings.json")); }
function getAppSettings(): AppSettings {
  if (!appSettings) throw new Error("应用设置尚未加载。");
  return appSettings;
}
async function saveAppSettings(partial: Partial<AppSettings>): Promise<void> {
  if (!settingsRepo) throw new Error("设置仓库尚未初始化。");
  await settingsRepo.save(partial);
  appSettings = await settingsRepo.load();
  debugInfo("settings", "saved", { keys: Object.keys(partial) });
}
function publishState(state: WorkspaceState): WorkspaceState { debugInfo("main", "workspace-state", { status: state.status, hasRoot: Boolean(state.workspaceRoot), sessionCount: state.sessions.length, selectedSessionId: state.selectedSessionId }); mainWindow?.webContents.send("app:initialization-state", state); return state; }

function selectedContext(): { root: string; session: SessionInfo } | null {
  const state = workspaceService?.getState();
  if (!state?.workspaceRoot || !state.selectedSessionId) return null;
  const session = state.sessions.find((item) => item.id === state.selectedSessionId);
  return session ? { root: state.workspaceRoot, session } : null;
}

async function refreshContext(context: { root: string; session: SessionInfo }): Promise<void> {
  if (workspaceService.getState().selectedSessionId === context.session.id) publishState(await workspaceService.refreshSelectedSession());
}

async function createWindow(): Promise<void> {
  const settings = getAppSettings();
  mainWindow = new BrowserWindow({
    width: settings.window.width,
    height: settings.window.height,
    minWidth: settings.window.minWidth,
    minHeight: settings.window.minHeight,
    backgroundColor: "#f4f7fb",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(__dirname, "preload.cjs") },
  });
  mainWindow.on("resized", () => {
    if (!mainWindow) return;
    const [width, height] = mainWindow.getSize();
    void saveAppSettings({ window: { ...getAppSettings().window, width, height } }).catch(() => undefined);
  });
  await mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  publishState(workspaceService.getState());
  mainWindow.on("closed", () => { mainWindow = null; });
}

async function requestProviderRuntimeApproval(request: ProviderRuntimeApprovalRequest): Promise<boolean> {
  if (!mainWindow) return false;
  const result = await dialog.showMessageBox(mainWindow, { type: "question", buttons: ["允许启动", "取消"], defaultId: 0, cancelId: 1, title: "Provider 启动审批", message: `是否允许启动 ${request.displayName}？`, detail: request.reason });
  return result.response === 0;
}

async function requestSensitiveOperationApproval(request: PermissionRequest): Promise<boolean> {
  if (!mainWindow) return false;
  const result = await dialog.showMessageBox(mainWindow, { type: "question", buttons: ["允许一次", "取消"], defaultId: 0, cancelId: 1, title: request.title, message: "此操作需要你的批准。", detail: request.detail });
  return result.response === 0;
}

async function checkWorkerHealth(): Promise<boolean> {
  const handle = workerService.start("ping", {}, () => undefined, { timeoutMs: 5_000 });
  return (await handle.completion).status === "completed";
}

async function bootstrap(): Promise<void> {
  settingsRepo = settingsRepository();
  appSettings = await settingsRepo.load();
  debugInfo("settings", "loaded", { workspaceRoot: appSettings.workspace.workspaceRoot, hasModelConfig: Boolean(appSettings.model.defaultConfig.baseUrl) });

  const appPath = app.getAppPath();
  const projectRoot = resolveProjectRoot(appPath, __dirname);
  const workerScript = resolveWorkerScript(appSettings.worker.scriptPath, projectRoot, appPath);
  const pythonExe = resolvePythonExecutable(process.env.TRIMUSIC_PYTHON, projectRoot, process.platform);
  debugInfo("python-worker", "using python", { python: pythonExe, appPath, projectRoot, workerScript });

  workerService = new WorkerService(new PythonWorkerClient({ workerScript, pythonExecutable: pythonExe, cwd: projectRoot }));
  permissions = new PermissionPolicy({ requestApproval: requestSensitiveOperationApproval });
  toolRegistry = new ToolRegistry(); toolRegistry.refresh(BUILT_IN_TOOL_MANIFESTS);
  modelService = new ModelService(new OpenAiCompatibleClient(), toolRegistry, permissions);
  sessionPersistence = new SessionPersistenceService(new FileSessionRepository());
  compressor = new StructuredContextCompressor();
  workspaceService = new WorkspaceService(new FileSystemWorkspaceRepository(), settingsRepo, installationDirectory(), () => new Date(), randomUUID, sessionPersistence);
  const providerRegistry = new ProviderRegistry();
  providerService = new ProviderService(providerRegistry, new AuthorizedMvpProviderGateway(workerScript, projectRoot), sessionPersistence, refreshContext);
  const approval = new ProviderRuntimeStartPolicy({ requestStartApproval: requestProviderRuntimeApproval });
  providerRuntimeService = new ProviderRuntimeService(new FakeMvpProviderRuntimeGateway(), providerRegistry, approval, sessionPersistence, refreshContext, (providerId, error) => { providerService.stopProvider(providerId, new ProviderContractError(error.code, error.message)); }, (event) => mainWindow?.webContents.send("provider:runtime-event", event));
  agentTaskService = new AgentTaskService(providerRuntimeService, providerService, permissions, sessionPersistence, refreshContext);
  debugInfo("main", "bootstrap-ready", { platform: process.platform, packaged: app.isPackaged });
  diagnosticsService = new DiagnosticsService(new SystemDiagnosticsGateway({
    checkWorker: checkWorkerHealth,
    listProviderStates: () => providerRuntimeService.list(),
  }));
  errorSearchService = new ErrorSearchService(new DuckDuckGoErrorSearchGateway(), permissions);

  const ipcContext: IpcContext = {
    get mainWindow() { return mainWindow; },
    workspaceService, workerService, modelService, toolRegistry, sessionPersistence,
    providerService, providerRuntimeService, compressor, diagnosticsService, errorSearchService,
    permissions, agentTaskService, getAppSettings, saveAppSettings, settingsRepo,
    publishState, selectedContext, requestProviderRuntimeApproval, requestSensitiveOperationApproval,
    checkWorkerHealth, activeModelRequests, activeModelTexts, activeTaskContexts, terminalModelRequests,
    get persistenceQueue() { return persistenceQueue; },
    setPersistenceQueue: (queue) => { persistenceQueue = queue; },
    setMainWindow: (win) => { mainWindow = win; },
  };
  registerIpc(ipcContext);
  await workspaceService.initialize();
  await providerRuntimeService.initialize(selectedContext() ?? undefined);
  await createWindow();
}

void app.whenReady().then(bootstrap).catch((error: unknown) => { dialog.showErrorBox("TriMusicAgent 初始化失败", error instanceof Error ? error.message : "未知错误"); app.quit(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0 && workspaceService) void createWindow(); });
