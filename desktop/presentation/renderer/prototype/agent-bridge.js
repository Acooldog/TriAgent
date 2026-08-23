const api = window.triMusicAgent;
let activeTaskId = null;
let unsubscribeAgent = null;

async function ensureSession() {
  let state = await api.getInitializationState();
  if (state.status !== "ready") {
    state = await api.chooseWorkspaceRoot();
  }
  if (state.status === "ready" && !state.selectedSessionId) {
    state = await api.createSession();
  }
  return state;
}

function permissionMode(value) {
  if (value === "受限") return "restricted";
  if (value === "完全访问") return "full";
  return "standard";
}

export async function startAgent(prompt, mode, onEvent) {
  const state = await ensureSession();
  if (state.status !== "ready" || !state.selectedSessionId) throw new Error("请先选择工作数据根目录并创建会话。");
  unsubscribeAgent?.();
  unsubscribeAgent = api.onAgentEvent((event) => onEvent?.(event));
  const result = await api.startAgentTask(prompt, permissionMode(mode));
  activeTaskId = result.taskId;
  return { ...result, state };
}

export async function cancelAgent() {
  if (!activeTaskId) return false;
  const result = await api.cancelAgentTask(activeTaskId);
  activeTaskId = null;
  return result;
}

export async function chooseWorkspace() { return api.chooseWorkspaceRoot(); }
export async function createSession() { return api.createSession(); }
export async function startModel(config, messages, mode, networkEnabled, onEvent) {
  const request = await api.startModel(config, messages, permissionMode(mode), networkEnabled);
  const unsubscribe = api.onModelEvent(({ requestId, event }) => { if (requestId === request.requestId) onEvent?.(event); });
  return { ...request, unsubscribe };
}

export async function cancelModel(requestId) { return api.cancelModel(requestId); }

window.triMusicPrototypeBridge = { startAgent, cancelAgent, chooseWorkspace, createSession, startModel, cancelModel };
