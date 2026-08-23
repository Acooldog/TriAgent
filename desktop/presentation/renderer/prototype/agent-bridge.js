const api = window.triMusicAgent;
let activeTaskId = null;
let unsubscribeAgent = null;
const debug = (event, payload = {}) => console.info(`[TriMusicAgent][bridge] ${event}`, payload);
const debugError = (event, error, payload = {}) => console.error(`[TriMusicAgent][bridge] ${event}`, { error: error instanceof Error ? error.message : error, ...payload });

async function ensureSession() {
  debug("session-state-request");
  let state = await api.getInitializationState();
  if (state.status !== "ready") {
    debug("workspace-choose-required"); state = await api.chooseWorkspaceRoot();
  }
  if (state.status === "ready" && !state.selectedSessionId) {
    debug("session-create-required"); state = await api.createSession();
  }
  return state;
}

function permissionMode(value) {
  if (value === "受限") return "restricted";
  if (value === "完全访问") return "full";
  return "standard";
}

async function startAgent(prompt, mode, onEvent) {
  debug("agent-start", { promptLength: prompt.length, mode });
  const state = await ensureSession();
  if (state.status !== "ready" || !state.selectedSessionId) throw new Error("请先选择工作数据根目录并创建会话。");
  unsubscribeAgent?.();
  unsubscribeAgent = api.onAgentEvent((event) => onEvent?.(event));
  const result = await api.startAgentTask(prompt, permissionMode(mode));
  debug("agent-start-accepted", { taskId: result.taskId });
  activeTaskId = result.taskId;
  return { ...result, state };
}

async function cancelAgent() {
  debug("agent-cancel", { taskId: activeTaskId });
  if (!activeTaskId) return false;
  const result = await api.cancelAgentTask(activeTaskId);
  activeTaskId = null;
  return result;
}

async function chooseWorkspace() { debug("workspace-choose"); try { return await api.chooseWorkspaceRoot(); } catch (error) { debugError("workspace-choose-error", error); throw error; } }
async function createSession() { debug("session-create"); return api.createSession(); }
async function startModel(config, messages, mode, networkEnabled, onEvent) {
  debug("model-start", { model: config.model, baseUrl: config.baseUrl, messageCount: messages.length, mode, networkEnabled, apiKeyConfigured: Boolean(config.apiKey) });
  const request = await api.startModel(config, messages, permissionMode(mode), networkEnabled);
  debug("model-start-accepted", { requestId: request.requestId });
  const unsubscribe = api.onModelEvent(({ requestId, event }) => { if (requestId === request.requestId) onEvent?.(event); });
  return { ...request, unsubscribe };
}

async function cancelModel(requestId) { debug("model-cancel", { requestId }); return api.cancelModel(requestId); }

window.triMusicPrototypeBridge = { startAgent, cancelAgent, chooseWorkspace, createSession, startModel, cancelModel };
