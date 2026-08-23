import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { BUILT_IN_TOOL_MANIFESTS } from "../application/builtInTools";
import { AgentTaskService, type AgentEvent } from "../application/agentTaskService";
import { StructuredContextCompressor, type CompressionOptions } from "../application/contextCompression";
import { DiagnosticsService, ErrorSearchService, type DiagnosticsRequest, type ErrorSearchIssue } from "../application/diagnostics";
import { ExecutionBudget } from "../application/executionBudget";
import { ModelService } from "../application/modelService";
import { PermissionPolicy, type PermissionRequest } from "../application/permissionPolicy";
import { ProviderContractError } from "../application/providerProtocol";
import { ProviderRegistry } from "../application/providerRegistry";
import { ProviderService } from "../application/providerService";
import { ProviderRuntimeService } from "../application/providerRuntimeService";
import { ProviderRuntimeStartPolicy } from "../application/providerRuntimePolicy";
import type { ProviderRuntimeApprovalRequest } from "../application/providerRuntimeProtocol";
import type { ChatMessage, ModelConfig, ModelEvent } from "../application/modelProtocol";
import { SessionPersistenceService, taskStatusForModelError, type SessionEventRecord, type SessionTaskState } from "../application/sessionPersistence";
import { ToolRegistry, validateManifest, type ToolManifest } from "../application/toolProtocol";
import { WorkspaceService, type SessionInfo, type WorkspaceState } from "../application/workspaceService";
import { WorkerService } from "../application/workerService";
import type { WorkerEvent, WorkerOperation } from "../application/workerProtocol";
import { FileSessionRepository } from "../infrastructure/sessionRepository";
import { EmptyProviderGateway } from "../infrastructure/emptyProviderGateway";
import { AuthorizedMvpProviderGateway } from "../infrastructure/authorizedMvpProviderGateway";
import { PrivateProviderRuntimeGateway } from "../infrastructure/privateProviderRuntimeGateway";
import { DuckDuckGoErrorSearchGateway } from "../infrastructure/duckDuckGoErrorSearch";
import { PythonWorkerClient } from "../infrastructure/pythonWorker";
import { OpenAiCompatibleClient } from "../infrastructure/openAiCompatibleClient";
import { WindowsRegistrySettingsRepository } from "../infrastructure/registrySettingsRepository";
import { JsonSettingsRepository } from "../infrastructure/settingsRepository";
import { SystemDiagnosticsGateway } from "../infrastructure/systemDiagnostics";
import { FileSystemWorkspaceRepository } from "../infrastructure/workspaceRepository";
import { registerProviderIpc } from "./providerIpc";

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
const activeModelRequests = new Map<string, AbortController>();
const activeModelTexts = new Map<string, string>();
const activeTaskContexts = new Map<string, { root: string; session: SessionInfo }>();
const terminalModelRequests = new Set<string>();
let persistenceQueue: Promise<void> = Promise.resolve();

function installationDirectory(): string { return app.isPackaged ? path.dirname(app.getPath("exe")) : app.getAppPath(); }
function settingsRepository(): WindowsRegistrySettingsRepository | JsonSettingsRepository { return process.platform === "win32" ? new WindowsRegistrySettingsRepository() : new JsonSettingsRepository(path.join(app.getPath("userData"), "settings.json")); }
function publishState(state: WorkspaceState): WorkspaceState { mainWindow?.webContents.send("app:initialization-state", state); return state; }

function selectedContext(): { root: string; session: SessionInfo } | null {
  const state = workspaceService?.getState();
  if (!state?.workspaceRoot || !state.selectedSessionId) return null;
  const session = state.sessions.find((item) => item.id === state.selectedSessionId);
  return session ? { root: state.workspaceRoot, session } : null;
}

function enqueuePersistence(label: string, operation: () => Promise<void>): void {
  const current = persistenceQueue.then(operation);
  persistenceQueue = current.catch((error: unknown) => {
    mainWindow?.webContents.send("session:persistence-error", { label, message: error instanceof Error ? error.message : "会话持久化失败。" });
  });
}

async function refreshContext(context: { root: string; session: SessionInfo }): Promise<void> {
  if (workspaceService.getState().selectedSessionId === context.session.id) publishState(await workspaceService.refreshSelectedSession());
}

function persistEvent(category: SessionEventRecord["category"], eventType: string, payload: Record<string, unknown>, details: Pick<SessionEventRecord, "status" | "taskId" | "requestId"> = {}, taskContext?: { root: string; session: SessionInfo }): void {
  const context = taskContext ?? selectedContext();
  if (!context) return;
  const event: SessionEventRecord = { eventId: randomUUID(), emittedAt: new Date().toISOString(), category, eventType, payload, ...details };
  enqueuePersistence(`event:${eventType}`, async () => {
    await sessionPersistence.recordEvent(context.root, context.session, event);
    await sessionPersistence.recordLog(context.root, context.session, { emittedAt: event.emittedAt, level: details.status === "failed" ? "error" : "info", message: eventType, context: { category, taskId: details.taskId, requestId: details.requestId } });
    await refreshContext(context);
  });
}

function persistTask(taskId: string, status: SessionTaskState["status"], requestId?: string, error?: { code: string; message: string }, taskContext?: { root: string; session: SessionInfo }): void {
  const context = taskContext ?? activeTaskContexts.get(taskId) ?? selectedContext();
  if (!context) return;
  enqueuePersistence(`task:${taskId}`, async () => {
    const existing = (await sessionPersistence.load(context.root, context.session)).tasks.find((task) => task.taskId === taskId);
    const now = new Date().toISOString();
    const task: SessionTaskState = { taskId, status, startedAt: existing?.startedAt ?? now, updatedAt: now, ...(status !== "running" ? { completedAt: now } : {}), ...(requestId ? { requestId } : existing?.requestId ? { requestId: existing.requestId } : {}), ...(error ? { error } : {}) };
    await sessionPersistence.updateTask(context.root, context.session, task);
    await refreshContext(context);
  });
}

function publishWorkerEvent(event: WorkerEvent): WorkerEvent {
  const context = activeTaskContexts.get(event.task_id);
  mainWindow?.webContents.send("worker:event", event);
  persistEvent("worker", event.event_type, { payload: event.payload, error: event.error }, { status: event.status, taskId: event.task_id, requestId: event.request_id }, context);
  if (event.event_type === "worker_finished" || event.status === "failed" || event.status === "cancelled") {
    persistTask(event.task_id, event.status === "cancelled" ? "stopped" : event.status, event.request_id, event.error ?? undefined, context);
    activeTaskContexts.delete(event.task_id);
  }
  return event;
}

function publishModelEvent(requestId: string, event: ModelEvent): void {
  const context = activeTaskContexts.get(requestId);
  mainWindow?.webContents.send("model:event", { requestId, event });
  if (event.type === "text_delta") activeModelTexts.set(requestId, `${activeModelTexts.get(requestId) ?? ""}${event.text}`);
  if (event.type === "response_completed") {
    const text = activeModelTexts.get(requestId) ?? "";
    if (context && text) enqueuePersistence(`assistant:${requestId}`, async () => { await sessionPersistence.appendMessage(context.root, context.session, { role: "assistant", content: text }); await refreshContext(context); });
    activeModelTexts.delete(requestId);
  }
  persistEvent("model", event.type, { event }, { requestId, status: event.type === "error" ? taskStatusForModelError(event.code) : event.type === "response_completed" ? "completed" : "running", taskId: requestId }, context);
  if (event.type === "error") { terminalModelRequests.add(requestId); activeModelTexts.delete(requestId); persistTask(requestId, taskStatusForModelError(event.code), requestId, { code: event.code, message: event.message }, context); activeTaskContexts.delete(requestId); }
}

function registerIpc(): void {
  registerProviderIpc({ ipc: ipcMain, service: providerService, runtime: providerRuntimeService, permissions, selectedContext, publishEvent: (event) => mainWindow?.webContents.send("provider:event", event) });
  ipcMain.handle("app:get-initialization-state", () => workspaceService.getState());
  ipcMain.handle("workspace:choose-root", async () => {
    if (!mainWindow) return workspaceService.getState();
    const result = await dialog.showOpenDialog(mainWindow, { title: "选择工作数据根目录", properties: ["openDirectory", "createDirectory"] });
    if (result.canceled || result.filePaths.length === 0) return workspaceService.getState();
    return publishState(await workspaceService.chooseWorkspaceRoot(result.filePaths[0]));
  });
  ipcMain.handle("session:create", async () => publishState(await workspaceService.createSession()));
  ipcMain.handle("session:select", async (_event, sessionId: unknown) => typeof sessionId === "string" ? publishState(await workspaceService.selectSession(sessionId)) : workspaceService.getState());
  ipcMain.handle("session:compress", async (_event, options: unknown) => {
    const context = selectedContext();
    if (!context) throw new Error("请先选择会话。");
    const snapshot = await sessionPersistence.load(context.root, context.session);
    const compression = await compressor.compress(snapshot.messages, isCompressionOptions(options) ? options : { thresholdTokens: 1200, preserveRecentMessages: 4, markdownThresholdTokens: 2400, writeMarkdown: false });
    if (compression.checkpoint) {
      const checkpointId = randomUUID();
      const reference = { checkpointId, jsonRelativePath: `checkpoints/${checkpointId}.json`, ...(compression.markdown ? { markdownRelativePath: `checkpoints/${checkpointId}.md` } : {}), createdAt: compression.checkpoint.createdAt, messageCount: compression.checkpoint.originalMessageCount, estimatedTokens: compression.checkpoint.estimatedTokens, reason: compression.reason };
      await sessionPersistence.writeCheckpoint(context.root, context.session, reference, compression.checkpoint, compression.markdown ?? undefined);
      await refreshContext(context);
    }
    persistEvent("system", "context_compression", { before: compression.estimatedTokensBefore, after: compression.estimatedTokensAfter, fallback: compression.fallback, reason: compression.reason }, { status: compression.fallback ? "failed" : compression.compressed ? "completed" : "skipped" });
    return compression;
  });
  ipcMain.handle("session:restore-original", async () => {
    const context = selectedContext();
    if (!context) throw new Error("请先选择会话。");
    await sessionPersistence.restoreOriginalContext(context.root, context.session);
    persistEvent("system", "context_restored", { mode: "original" }, { status: "completed" }, context);
    return publishState(await workspaceService.refreshSelectedSession());
  });
  ipcMain.handle("worker:start", async (_event, operation: unknown, payload: unknown, permissionMode: unknown) => {
    if (operation !== "ping" && operation !== "decrypt") throw new Error("不支持此 worker 操作。");
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new Error("worker 参数必须是对象。");
    if (permissionMode !== "restricted" && permissionMode !== "standard" && permissionMode !== "full") throw new Error("权限模式无效。");
    await permissions.authorize({ mode: permissionMode, operation: operation === "ping" ? "built-in" : "process", title: "Python worker 审批", detail: operation === "ping" ? "运行只读健康检查。" : "启动 Python worker 执行本地处理。" });
    let handle;
    try { handle = workerService.start(operation as WorkerOperation, payload as Record<string, unknown>, publishWorkerEvent); } catch (error) { throw new Error(error instanceof Error ? error.message : "worker 启动失败。"); }
    const context = selectedContext();
    if (context) activeTaskContexts.set(handle.taskId, context);
    persistTask(handle.taskId, "running", handle.requestId, undefined, context ?? undefined);
    void handle.completion.catch((error: unknown) => {
      const errorCode = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "worker-failed";
      publishWorkerEvent({ protocol_version: "1", request_id: handle.requestId, task_id: handle.taskId, event_type: "worker_finished", status: errorCode === "worker-cancelled" ? "cancelled" : "failed", payload: {}, error: { code: errorCode, message: error instanceof Error ? error.message : "worker 执行失败。" }, emitted_at: new Date().toISOString() });
    });
    return { requestId: handle.requestId, taskId: handle.taskId };
  });
  ipcMain.handle("worker:cancel", (_event, taskId: unknown) => { if (typeof taskId !== "string") return false; const cancelled = workerService.cancel(taskId); if (cancelled) persistTask(taskId, "stopped", undefined, { code: "cancelled", message: "用户已取消任务。" }, activeTaskContexts.get(taskId)); return cancelled; });
  ipcMain.handle("model:stream", async (_event, config: unknown, messages: unknown, permissionMode: unknown, networkEnabled: unknown) => {
    if (!isModelConfig(config) || !Array.isArray(messages) || !messages.every(isChatMessage)) throw new Error("模型配置或消息格式无效。");
    if (permissionMode !== "restricted" && permissionMode !== "standard" && permissionMode !== "full") throw new Error("权限模式无效。");
    if (typeof networkEnabled !== "boolean") throw new Error("联网设置无效。");
    if (!networkEnabled) throw new Error("联网默认关闭，请先在当前会话中启用联网。");
    await permissions.authorize({ mode: permissionMode, operation: "network", networkEnabled, title: "模型联网审批", detail: "允许模型服务访问网络并发送当前请求摘要。" });
    const context = selectedContext();
    const requestId = randomUUID();
    let requestMessages = messages;
    if (context) {
      const snapshot = await sessionPersistence.load(context.root, context.session);
      await sessionPersistence.saveConfig(context.root, context.session, config, { permissionMode });
      for (const message of messages) await sessionPersistence.appendMessage(context.root, context.session, message);
      requestMessages = [...snapshot.activeContext, ...messages];
      activeTaskContexts.set(requestId, context);
    }
    const budget = new ExecutionBudget();
    const boundedConfig = { ...config, totalTimeoutMs: Math.min(config.totalTimeoutMs ?? budget.remainingMs(), budget.remainingMs()) };
    const controller = new AbortController(); activeModelRequests.set(requestId, controller); persistTask(requestId, "running", requestId, undefined, context ?? undefined);
    terminalModelRequests.delete(requestId);
    void modelService.stream({ config: boundedConfig, messages: requestMessages, permissionMode, networkEnabled, budget, allowJsonFallback: true, signal: controller.signal }, (event) => publishModelEvent(requestId, event)).then(() => {
      if (!terminalModelRequests.has(requestId)) {
        terminalModelRequests.add(requestId);
        persistTask(requestId, "completed", requestId, undefined, activeTaskContexts.get(requestId));
        activeTaskContexts.delete(requestId);
      }
    }).catch((error: unknown) => {
      if (!terminalModelRequests.has(requestId)) publishModelEvent(requestId, { type: "error", code: errorCode(error), message: error instanceof Error ? error.message : "模型请求失败。", retryable: Boolean(error && typeof error === "object" && "retryable" in error && error.retryable === true) });
    }).finally(() => { activeModelRequests.delete(requestId); terminalModelRequests.delete(requestId); });
    return { requestId };
  });
  ipcMain.handle("model:cancel", (_event, requestId: unknown) => { if (typeof requestId !== "string") return false; const controller = activeModelRequests.get(requestId); if (!controller) return false; controller.abort(); persistTask(requestId, "stopped", requestId, { code: "cancelled", message: "用户已取消任务。" }, activeTaskContexts.get(requestId)); return true; });
  ipcMain.handle("tools:list", () => toolRegistry.list());
  ipcMain.handle("tools:refresh", (_event, manifests: unknown) => { if (!Array.isArray(manifests)) throw new Error("工具清单必须是数组。"); for (const manifest of manifests) validateManifest(manifest as ToolManifest); toolRegistry.refresh(manifests as ToolManifest[]); return toolRegistry.list(); });
  ipcMain.handle("diagnostics:run", async (_event, value: unknown) => {
    const request = parseDiagnosticsRequest(value);
    if (request.networkEnabled) await permissions.authorize({ mode: request.permissionMode, operation: "network", networkEnabled: true, title: "诊断联网审批", detail: "允许诊断访问模型服务检查连接状态。" });
    const context = selectedContext();
    const logsLocation = context ? path.join(context.root, context.session.relativePath, "logs.jsonl") : null;
    const report = await diagnosticsService.run({ modelConfig: request.modelConfig, networkEnabled: request.networkEnabled, sessionReady: context !== null, logsLocation });
    persistEvent("system", "diagnostics_completed", { statuses: report.items.map((item) => ({ category: item.category, status: item.status })) }, { status: report.items.some((item) => item.status === "error") ? "failed" : "completed" }, context ?? undefined);
    return report;
  });
  ipcMain.handle("diagnostics:search", async (_event, issueValue: unknown, mode: unknown, networkEnabled: unknown) => {
    const issue = parseErrorSearchIssue(issueValue);
    if (mode !== "restricted" && mode !== "standard" && mode !== "full") throw new Error("权限模式无效。");
    if (typeof networkEnabled !== "boolean") throw new Error("联网设置无效。");
    const result = await errorSearchService.search(issue, mode, networkEnabled);
    persistEvent("system", "diagnostic_search_stopped", { category: issue.category, resultCount: result.results.length }, { status: result.status });
    return result;
  });
  ipcMain.handle("agent:plan", (_event, prompt: unknown) => { if (typeof prompt !== "string") throw new Error("任务内容无效。"); return agentTaskService.createPlan(prompt); });
  ipcMain.handle("agent:start", async (_event, prompt: unknown, mode: unknown) => {
    if (typeof prompt !== "string" || !prompt.trim()) throw new Error("任务内容不能为空。");
    if (mode !== "restricted" && mode !== "standard" && mode !== "full") throw new Error("权限模式无效。");
    const handle = agentTaskService.start(prompt, mode, selectedContext() ?? undefined, (event: AgentEvent) => mainWindow?.webContents.send("agent:event", event));
    void handle.completion.catch(() => undefined);
    return { taskId: handle.taskId, plan: handle.plan };
  });
  ipcMain.handle("agent:cancel", (_event, taskId: unknown) => typeof taskId === "string" ? agentTaskService.cancel(taskId) : false);
}

async function createWindow(): Promise<void> { mainWindow = new BrowserWindow({ width: 1080, height: 720, minWidth: 760, minHeight: 520, backgroundColor: "#f4f7fb", webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(__dirname, "preload.cjs") } }); await mainWindow.loadFile(path.join(__dirname, "renderer", "index.html")); publishState(workspaceService.getState()); mainWindow.on("closed", () => { mainWindow = null; }); }
async function bootstrap(): Promise<void> {
  workerService = new WorkerService(new PythonWorkerClient({ workerScript: path.join(app.getAppPath(), "src", "Presentation", "worker.py") }));
  permissions = new PermissionPolicy({ requestApproval: requestSensitiveOperationApproval });
  toolRegistry = new ToolRegistry(); toolRegistry.refresh(BUILT_IN_TOOL_MANIFESTS); modelService = new ModelService(new OpenAiCompatibleClient(), toolRegistry, permissions);
  sessionPersistence = new SessionPersistenceService(new FileSessionRepository()); compressor = new StructuredContextCompressor();
  workspaceService = new WorkspaceService(new FileSystemWorkspaceRepository(), settingsRepository(), installationDirectory(), () => new Date(), randomUUID, sessionPersistence);
  const providerRegistry = new ProviderRegistry(); providerService = new ProviderService(providerRegistry, new AuthorizedMvpProviderGateway(path.join(app.getAppPath(), "src", "Presentation", "worker.py"), app.getAppPath(), process.env.TRIMUSIC_PYTHON), sessionPersistence, refreshContext);
  const approval = new ProviderRuntimeStartPolicy({ requestStartApproval: requestProviderRuntimeApproval });
  providerRuntimeService = new ProviderRuntimeService(new PrivateProviderRuntimeGateway(), providerRegistry, approval, sessionPersistence, refreshContext, (providerId, error) => { providerService.stopProvider(providerId, new ProviderContractError(error.code, error.message)); }, (event) => mainWindow?.webContents.send("provider:runtime-event", event));
  agentTaskService = new AgentTaskService(providerRuntimeService, providerService, permissions, sessionPersistence, refreshContext);
  diagnosticsService = new DiagnosticsService(new SystemDiagnosticsGateway({ checkWorker: checkWorkerHealth, listProviderStates: () => providerRuntimeService.list() }));
  errorSearchService = new ErrorSearchService(new DuckDuckGoErrorSearchGateway(), permissions);
  registerIpc(); await workspaceService.initialize(); await providerRuntimeService.initialize(selectedContext() ?? undefined); await createWindow();
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
function parseDiagnosticsRequest(value: unknown): DiagnosticsRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("诊断请求无效。");
  const request = value as Record<string, unknown>;
  if (typeof request.networkEnabled !== "boolean" || (request.permissionMode !== "restricted" && request.permissionMode !== "standard" && request.permissionMode !== "full")) throw new Error("诊断设置无效。");
  if (request.modelConfig !== undefined && !isModelConfig(request.modelConfig)) throw new Error("模型配置无效。");
  return { networkEnabled: request.networkEnabled, permissionMode: request.permissionMode, ...(request.modelConfig ? { modelConfig: request.modelConfig } : {}) };
}
function parseErrorSearchIssue(value: unknown): ErrorSearchIssue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("错误搜索请求无效。");
  const issue = value as Record<string, unknown>;
  if (!isDiagnosticCategory(issue.category) || typeof issue.summary !== "string" || !issue.summary.trim()) throw new Error("错误搜索摘要无效。");
  return { category: issue.category, summary: issue.summary };
}
function isDiagnosticCategory(value: unknown): value is ErrorSearchIssue["category"] { return value === "ffmpeg" || value === "model" || value === "worker" || value === "session" || value === "provider"; }
function isCompressionOptions(value: unknown): value is CompressionOptions { if (typeof value !== "object" || value === null || Array.isArray(value)) return false; const options = value as Record<string, unknown>; return typeof options.thresholdTokens === "number" && Number.isFinite(options.thresholdTokens) && options.thresholdTokens > 0 && typeof options.preserveRecentMessages === "number" && Number.isInteger(options.preserveRecentMessages) && options.preserveRecentMessages >= 1 && (options.markdownThresholdTokens === undefined || typeof options.markdownThresholdTokens === "number" && Number.isFinite(options.markdownThresholdTokens) && options.markdownThresholdTokens > 0) && (options.markdownMaxRatio === undefined || typeof options.markdownMaxRatio === "number" && options.markdownMaxRatio > 0 && options.markdownMaxRatio < 1) && (options.writeMarkdown === undefined || typeof options.writeMarkdown === "boolean"); }
function isModelConfig(value: unknown): value is ModelConfig { if (typeof value !== "object" || value === null || Array.isArray(value)) return false; const config = value as Record<string, unknown>; if (typeof config.baseUrl !== "string" || !config.baseUrl.trim() || typeof config.model !== "string" || !config.model.trim()) return false; if (config.apiKey !== undefined && typeof config.apiKey !== "string") return false; if (config.headers !== undefined && (typeof config.headers !== "object" || config.headers === null || Array.isArray(config.headers))) return false; for (const key of ["maxTokens", "temperature", "connectTimeoutMs", "firstByteTimeoutMs", "readTimeoutMs", "totalTimeoutMs"]) if (config[key] !== undefined && (typeof config[key] !== "number" || !Number.isFinite(config[key]))) return false; return config.thinking === undefined || config.thinking === "enabled" || config.thinking === "disabled"; }
function isChatMessage(value: unknown): value is ChatMessage { if (typeof value !== "object" || value === null || Array.isArray(value)) return false; const message = value as Record<string, unknown>; return ["system", "user", "assistant", "tool"].includes(String(message.role)) && (typeof message.content === "string" || message.content === null); }
function errorCode(error: unknown): string { return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "model-error"; }
void app.whenReady().then(bootstrap).catch((error: unknown) => { dialog.showErrorBox("TriMusicAgent 初始化失败", error instanceof Error ? error.message : "未知错误"); app.quit(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0 && workspaceService) void createWindow(); });
