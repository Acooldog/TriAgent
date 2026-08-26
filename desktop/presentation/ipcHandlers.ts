import { BrowserWindow, dialog, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentTaskService, AgentEvent } from "../application/agentTaskService";
import type { AppSettings, AppSettingsRepository } from "../application/appSettings";
import type { StructuredContextCompressor, CompressionOptions } from "../application/contextCompression";
import type { DiagnosticsService, ErrorSearchService, DiagnosticsRequest, ErrorSearchIssue } from "../application/diagnostics";
import { ExecutionBudget } from "../application/executionBudget";
import type { ModelService } from "../application/modelService";
import type { PermissionPolicy, PermissionRequest } from "../application/permissionPolicy";
import { PermissionPolicyError } from "../application/permissionPolicy";
import { ProviderContractError } from "../application/providerProtocol";
import type { ProviderService } from "../application/providerService";
import type { ProviderRuntimeService } from "../application/providerRuntimeService";
import type { ProviderRuntimeApprovalRequest } from "../application/providerRuntimeProtocol";
import type { ChatMessage, ModelConfig, ModelEvent } from "../application/modelProtocol";
import type { SessionPersistenceService, SessionEventRecord, SessionLogRecord, SessionTaskState } from "../application/sessionPersistence";
import type { ToolRegistry, ToolManifest } from "../application/toolProtocol";
import type { WorkspaceService, SessionInfo, WorkspaceState, WorkspaceSettings } from "../application/workspaceService";
import type { WorkerService } from "../application/workerService";
import type { WorkerEvent, WorkerOperation } from "../application/workerProtocol";
import { registerProviderIpc } from "./providerIpc";
import { debugError, debugInfo } from "../application/debugLogger";
import { createRendererEventPublisher } from "./rendererEventPublisher";
import { createWorkerSessionLog } from "./workerSessionLog";

export interface IpcContext {
  mainWindow: BrowserWindow | null;
  workspaceService: WorkspaceService;
  workerService: WorkerService;
  modelService: ModelService;
  toolRegistry: ToolRegistry;
  sessionPersistence: SessionPersistenceService;
  providerService: ProviderService;
  providerRuntimeService: ProviderRuntimeService;
  compressor: StructuredContextCompressor;
  diagnosticsService: DiagnosticsService;
  errorSearchService: ErrorSearchService;
  permissions: PermissionPolicy;
  agentTaskService: AgentTaskService;
  getAppSettings: () => AppSettings;
  saveAppSettings: (partial: Partial<AppSettings>) => Promise<void>;
  settingsRepo: (AppSettingsRepository & WorkspaceSettings) | null;
  publishState: (state: WorkspaceState) => WorkspaceState;
  selectedContext: () => { root: string; session: SessionInfo } | null;
  requestProviderRuntimeApproval: (request: ProviderRuntimeApprovalRequest) => Promise<boolean>;
  requestSensitiveOperationApproval: (request: PermissionRequest) => Promise<boolean>;
  checkWorkerHealth: () => Promise<boolean>;
  activeModelRequests: Map<string, AbortController>;
  activeModelTexts: Map<string, string>;
  activeTaskContexts: Map<string, { root: string; session: SessionInfo }>;
  terminalModelRequests: Set<string>;
  persistenceQueue: Promise<void>;
  setPersistenceQueue: (queue: Promise<void>) => void;
  setMainWindow: (win: BrowserWindow | null) => void;
}

export function registerIpc(ctx: IpcContext): void {
  const { workspaceService, workerService, modelService, toolRegistry, sessionPersistence, providerService, providerRuntimeService, compressor, diagnosticsService, errorSearchService, permissions, agentTaskService, getAppSettings, saveAppSettings, settingsRepo, publishState, selectedContext, requestProviderRuntimeApproval, requestSensitiveOperationApproval, checkWorkerHealth, activeModelRequests, activeModelTexts, activeTaskContexts, terminalModelRequests, setPersistenceQueue, setMainWindow } = ctx;
  const publishRendererEvent = createRendererEventPublisher(() => ctx.mainWindow);

  const enqueuePersistence = (label: string, operation: () => Promise<void>): void => {
    debugInfo("persistence", "enqueue", { label });
    const current = ctx.persistenceQueue.then(operation);
    setPersistenceQueue(current.catch((error: unknown) => {
      debugError("persistence", "error", error, { label });
      publishRendererEvent("session:persistence-error", { label, message: error instanceof Error ? error.message : "会话持久化失败。" });
    }));
  };

  const refreshContext = async (context: { root: string; session: SessionInfo }): Promise<void> => {
    if (workspaceService.getState().selectedSessionId === context.session.id) publishState(await workspaceService.refreshSelectedSession());
  };

  const persistEvent = (category: SessionEventRecord["category"], eventType: string, payload: Record<string, unknown>, details: Pick<SessionEventRecord, "status" | "taskId" | "requestId"> = {}, taskContext?: { root: string; session: SessionInfo }, logRecord?: SessionLogRecord): void => {
    const context = taskContext ?? selectedContext();
    if (!context) return;
    const event: SessionEventRecord = { eventId: randomUUID(), emittedAt: new Date().toISOString(), category, eventType, payload, ...details };
    enqueuePersistence(`event:${eventType}`, async () => {
      await sessionPersistence.recordEvent(context.root, context.session, event);
      await sessionPersistence.recordLog(context.root, context.session, logRecord ?? { emittedAt: event.emittedAt, level: details.status === "failed" ? "error" : "info", message: eventType, context: { category, taskId: details.taskId, requestId: details.requestId } });
      await refreshContext(context);
    });
  };

  const persistTask = (taskId: string, status: SessionTaskState["status"], requestId?: string, error?: { code: string; message: string }, taskContext?: { root: string; session: SessionInfo }): void => {
    const context = taskContext ?? activeTaskContexts.get(taskId) ?? selectedContext();
    if (!context) return;
    enqueuePersistence(`task:${taskId}`, async () => {
      const existing = (await sessionPersistence.load(context.root, context.session)).tasks.find((task) => task.taskId === taskId);
      const now = new Date().toISOString();
      const task: SessionTaskState = { taskId, status, startedAt: existing?.startedAt ?? now, updatedAt: now, ...(status !== "running" ? { completedAt: now } : {}), ...(requestId ? { requestId } : existing?.requestId ? { requestId: existing.requestId } : {}), ...(error ? { error } : {}) };
      await sessionPersistence.updateTask(context.root, context.session, task);
      await refreshContext(context);
    });
  };

  const publishWorkerEvent = (event: WorkerEvent): WorkerEvent => {
    const context = activeTaskContexts.get(event.task_id);
    publishRendererEvent("worker:event", event);
    persistEvent("worker", event.event_type, { payload: event.payload, error: event.error }, { status: event.status, taskId: event.task_id, requestId: event.request_id }, context, createWorkerSessionLog(event));
    if (event.event_type === "worker_finished" || event.status === "failed" || event.status === "cancelled") {
      persistTask(event.task_id, event.status === "cancelled" ? "stopped" : event.status, event.request_id, event.error ?? undefined, context);
      activeTaskContexts.delete(event.task_id);
    }
    return event;
  };

  const publishModelEvent = (requestId: string, event: ModelEvent): void => {
    debugInfo("model-ipc", "publish-event", { requestId, type: event.type });
    const context = activeTaskContexts.get(requestId);
    publishRendererEvent("model:event", { requestId, event });
    if (event.type === "text_delta") activeModelTexts.set(requestId, `${activeModelTexts.get(requestId) ?? ""}${event.text}`);
    if (event.type === "response_completed") {
      const text = activeModelTexts.get(requestId) ?? "";
      if (context && text) enqueuePersistence(`assistant:${requestId}`, async () => { await sessionPersistence.appendMessage(context.root, context.session, { role: "assistant", content: text }); await refreshContext(context); });
      activeModelTexts.delete(requestId);
    }
    persistEvent("model", event.type, { event }, { requestId, status: event.type === "error" ? "failed" : event.type === "response_completed" ? "completed" : "running", taskId: requestId }, context);
    if (event.type === "error") { terminalModelRequests.add(requestId); activeModelTexts.delete(requestId); persistTask(requestId, "failed", requestId, { code: event.code, message: event.message }, context); activeTaskContexts.delete(requestId); }
  };

  debugInfo("main", "register-ipc");
  registerProviderIpc({ ipc: ipcMain, service: providerService, runtime: providerRuntimeService, permissions, selectedContext, publishEvent: (event) => { publishRendererEvent("provider:event", event); } });

  ipcMain.handle("app:get-initialization-state", () => { debugInfo("workspace-ipc", "get-state"); return workspaceService.getState(); });
  ipcMain.handle("workspace:choose-root", async () => {
    debugInfo("workspace-ipc", "choose-root");
    const currentWindow = ctx.mainWindow;
    if (!currentWindow) return workspaceService.getState();
    const result = await dialog.showOpenDialog(currentWindow, { title: "选择工作数据根目录", properties: ["openDirectory", "createDirectory"] });
    if (result.canceled || result.filePaths.length === 0) return workspaceService.getState();
    return publishState(await workspaceService.chooseWorkspaceRoot(result.filePaths[0]));
  });

  ipcMain.handle("session:create", async () => { debugInfo("session-ipc", "create"); return publishState(await workspaceService.createSession()); });
  ipcMain.handle("session:select", async (_event, sessionId: unknown) => { debugInfo("session-ipc", "select", { sessionId }); return typeof sessionId === "string" ? publishState(await workspaceService.selectSession(sessionId)) : workspaceService.getState(); });
  ipcMain.handle("session:compress", async (_event, options: unknown) => {
    debugInfo("session-ipc", "compress", { hasOptions: Boolean(options) });
    const context = selectedContext();
    if (!context) throw new Error("请先选择会话。");
    const snapshot = await sessionPersistence.load(context.root, context.session);
    const defaults = getAppSettings().compression.defaults;
    const compression = await compressor.compress(snapshot.messages, isCompressionOptions(options) ? options : defaults);
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
    debugInfo("session-ipc", "restore-original");
    const context = selectedContext();
    if (!context) throw new Error("请先选择会话。");
    await sessionPersistence.restoreOriginalContext(context.root, context.session);
    persistEvent("system", "context_restored", { mode: "original" }, { status: "completed" }, context);
    return publishState(await workspaceService.refreshSelectedSession());
  });

  ipcMain.handle("worker:start", async (_event, operation: unknown, payload: unknown, permissionMode: unknown) => {
    debugInfo("worker-ipc", "start-request", { operation, permissionMode });
    if (operation !== "ping" && operation !== "capability" && operation !== "agent") throw new Error("不支持此 worker 操作。");
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new Error("worker 参数必须是对象。");
    if (permissionMode !== "restricted" && permissionMode !== "standard" && permissionMode !== "full") throw new Error("权限模式无效。");
    const opLabel = operation === "ping" ? "built-in" : operation === "agent" ? "agent" : "process";
    const opDetail = operation === "ping" ? "运行只读健康检查。" : operation === "agent" ? "启动 Agent 执行音乐处理任务。" : "启动 Python worker 执行本地处理。";
    await permissions.authorize({ mode: permissionMode, operation: opLabel, title: "Python worker 审批", detail: opDetail });
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

  ipcMain.handle("worker:cancel", (_event, taskId: unknown) => { debugInfo("worker-ipc", "cancel-request", { taskId }); if (typeof taskId !== "string") return false; const cancelled = workerService.cancel(taskId); if (cancelled) persistTask(taskId, "stopped", undefined, { code: "cancelled", message: "用户已取消任务。" }, activeTaskContexts.get(taskId)); return cancelled; });
  ipcMain.handle("model:stream", async (_event, config: unknown, messages: unknown, permissionMode: unknown, networkEnabled: unknown) => {
    debugInfo("model-ipc", "stream-request", { model: isRecordValue(config) ? config.model : undefined, baseUrl: isRecordValue(config) ? config.baseUrl : undefined, messageCount: Array.isArray(messages) ? messages.length : 0, permissionMode, networkEnabled, apiKeyConfigured: isRecordValue(config) && typeof config.apiKey === "string" && config.apiKey.length > 0 });
    if (!isModelConfig(config) || !Array.isArray(messages) || !messages.every(isChatMessage)) throw new Error("模型配置或消息格式无效。");
    if (permissionMode !== "restricted" && permissionMode !== "standard" && permissionMode !== "full") throw new Error("权限模式无效。");
    if (typeof networkEnabled !== "boolean") throw new Error("联网设置无效。");
    if (networkEnabled) {
      debugInfo("model-ipc", "network-enabled", "联网已开启，用户已主动启用联网功能");
      if (permissionMode === "restricted") {
        throw new PermissionPolicyError("permission-denied", "受限模式不允许联网模型请求。");
      }
    } else {
      debugInfo("model-ipc", "network-disabled", "联网未开启，将直接发送请求");
    }
    const context = selectedContext();
    const requestId = randomUUID();
    let requestMessages = messages;
    if (context) {
      try {
        const snapshot = await sessionPersistence.load(context.root, context.session);
        await sessionPersistence.saveConfig(context.root, context.session, config, { permissionMode });
        for (const message of messages) await sessionPersistence.appendMessage(context.root, context.session, message);
        requestMessages = [...snapshot.activeContext, ...messages];
        activeTaskContexts.set(requestId, context);
      } catch (sessionError) {
        debugError("model-ipc", "session-persistence-failed", sessionError, { requestId });
        publishRendererEvent("session:persistence-warning", {
          requestId,
          message: "会话持久化失败，模型可能失去上下文记忆。",
        });
      }
    }
    const budget = new ExecutionBudget();
    const boundedConfig = { ...config, totalTimeoutMs: Math.min(config.totalTimeoutMs ?? budget.remainingMs(), budget.remainingMs()) };
    const controller = new AbortController(); activeModelRequests.set(requestId, controller); persistTask(requestId, "running", requestId, undefined, context ?? undefined);
    terminalModelRequests.delete(requestId);
    void modelService.stream({ config: boundedConfig, messages: requestMessages, permissionMode, networkEnabled, budget, allowJsonFallback: true, signal: controller.signal }, (event) => { debugInfo("model-ipc", "event", { requestId, type: event.type, code: event.type === "error" ? event.code : undefined }); publishModelEvent(requestId, event); }).then(() => {
      if (!terminalModelRequests.has(requestId)) {
        terminalModelRequests.add(requestId);
        persistTask(requestId, "completed", requestId, undefined, activeTaskContexts.get(requestId));
        activeTaskContexts.delete(requestId);
      }
    }).catch((error: unknown) => {
      debugError("model-ipc", "stream-error", error, { requestId });
      if (!terminalModelRequests.has(requestId)) publishModelEvent(requestId, { type: "error", code: errorCode(error), message: error instanceof Error ? error.message : "模型请求失败。", retryable: Boolean(error && typeof error === "object" && "retryable" in error && error.retryable === true) });
    }).finally(() => { activeModelRequests.delete(requestId); terminalModelRequests.delete(requestId); });
    return { requestId };
  });

  ipcMain.handle("model:cancel", (_event, requestId: unknown) => { if (typeof requestId !== "string") return false; const controller = activeModelRequests.get(requestId); if (!controller) return false; controller.abort(); persistTask(requestId, "stopped", requestId, { code: "cancelled", message: "用户已取消任务。" }, activeTaskContexts.get(requestId)); return true; });
  ipcMain.handle("model:save-config", async (_event, config: unknown) => {
    debugInfo("model-ipc", "save-config", { model: isRecordValue(config) ? config.model : undefined, baseUrl: isRecordValue(config) ? config.baseUrl : undefined, apiKeyConfigured: isRecordValue(config) && typeof config.apiKey === "string" && config.apiKey.length > 0 });
    if (!isModelConfig(config)) throw new Error("模型配置无效。");
    const context = selectedContext();
    if (!context) throw new Error("请先选择工作区和会话。");
    await sessionPersistence.saveConfig(context.root, context.session, config, { permissionMode: "standard" });
    const { apiKey: _apiKey, ...defaultConfig } = config;
    await saveAppSettings({ model: { defaultConfig } });
    await refreshContext(context);
    return true;
  });

  ipcMain.handle("tools:list", () => toolRegistry.list());
  ipcMain.handle("tools:refresh", (_event, manifests: unknown) => { if (!Array.isArray(manifests)) throw new Error("工具清单必须是数组。"); for (const manifest of manifests) validateManifest(manifest as ToolManifest); toolRegistry.refresh(manifests as ToolManifest[]); return toolRegistry.list(); });
  ipcMain.handle("diagnostics:run", async (_event, value: unknown) => {
    debugInfo("diagnostics-ipc", "run");
    const request = parseDiagnosticsRequest(value);
    if (request.networkEnabled) await permissions.authorize({ mode: request.permissionMode, operation: "network", networkEnabled: true, title: "诊断联网审批", detail: "允许诊断访问模型服务检查连接状态。" });
    const context = selectedContext();
    const logsLocation = context ? path.join(context.root, context.session.relativePath, "logs.jsonl") : null;
    const report = await diagnosticsService.run({ modelConfig: request.modelConfig, networkEnabled: request.networkEnabled, sessionReady: context !== null, logsLocation });
    persistEvent("system", "diagnostics_completed", { statuses: report.items.map((item) => ({ category: item.category, status: item.status })) }, { status: report.items.some((item) => item.status === "error") ? "failed" : "completed" }, context ?? undefined);
    return report;
  });
  ipcMain.handle("diagnostics:search", async (_event, issueValue: unknown, mode: unknown, networkEnabled: unknown) => {
    debugInfo("diagnostics-ipc", "search", { mode, networkEnabled });
    const issue = parseErrorSearchIssue(issueValue);
    if (mode !== "restricted" && mode !== "standard" && mode !== "full") throw new Error("权限模式无效。");
    if (typeof networkEnabled !== "boolean") throw new Error("联网设置无效。");
    const result = await errorSearchService.search(issue, mode, networkEnabled);
    persistEvent("system", "diagnostic_search_stopped", { category: issue.category, resultCount: result.results.length }, { status: result.status });
    return result;
  });

  ipcMain.handle("agent:plan", (_event, prompt: unknown) => { if (typeof prompt !== "string") throw new Error("任务内容无效。"); return agentTaskService.createPlan(prompt); });
  ipcMain.handle("agent:start", async (_event, prompt: unknown, mode: unknown) => {
    debugInfo("agent-ipc", "start-request", { promptLength: typeof prompt === "string" ? prompt.length : 0, mode });
    if (typeof prompt !== "string" || !prompt.trim()) throw new Error("任务内容不能为空。");
    if (mode !== "restricted" && mode !== "standard" && mode !== "full") throw new Error("权限模式无效。");
    const handle = agentTaskService.start(prompt, mode, selectedContext() ?? undefined, (event: AgentEvent) => { debugInfo("agent-ipc", "event", { taskId: event.taskId, type: event.type, status: event.status }); publishRendererEvent("agent:event", event); });
    void handle.completion.catch(() => undefined);
    return { taskId: handle.taskId, plan: handle.plan };
  });
  ipcMain.handle("agent:cancel", (_event, taskId: unknown) => { debugInfo("agent-ipc", "cancel-request", { taskId }); return typeof taskId === "string" ? agentTaskService.cancel(taskId) : false; });

  ipcMain.handle("app:get-settings", () => {
    debugInfo("settings-ipc", "get-settings");
    return getAppSettings();
  });
  ipcMain.handle("app:update-settings", async (_event, partial: unknown) => {
    debugInfo("settings-ipc", "update-settings");
    if (typeof partial !== "object" || partial === null || Array.isArray(partial)) throw new Error("设置必须是对象。");
    await saveAppSettings(partial as Partial<AppSettings>);
    return getAppSettings();
  });
  ipcMain.handle("app:reset-settings", async () => {
    debugInfo("settings-ipc", "reset-settings");
    if (!settingsRepo) throw new Error("设置仓库尚未初始化。");
    return settingsRepo.reset();
  });
}

function validateManifest(manifest: ToolManifest): void {
  if (!manifest.name || !manifest.description) throw new Error("工具清单缺少必填字段。");
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
function isRecordValue(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isChatMessage(value: unknown): value is ChatMessage { if (typeof value !== "object" || value === null || Array.isArray(value)) return false; const message = value as Record<string, unknown>; return ["system", "user", "assistant", "tool"].includes(String(message.role)) && (typeof message.content === "string" || message.content === null); }
function errorCode(error: unknown): string { return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "model-error"; }
