import "./agent-bridge.js";

const root = document.querySelector("#app");
let activeTaskId = null;
let activeModel = null;
const debug = (event, payload = {}) => console.info(`[TriMusicAgent][renderer] ${event}`, payload);
const debugError = (event, error, payload = {}) => console.error(`[TriMusicAgent][renderer] ${event}`, { error: error instanceof Error ? error.message : error, ...payload });

document.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  debug("click", { action, page: window.triMusicPrototypeRuntime?.state?.page });
  const runtime = window.triMusicPrototypeRuntime;
  if (!runtime) { console.error("TriMusicAgent 运行时尚未初始化。"); return; }
  if (action === "start" && (runtime.state.page === "dashboard" || runtime.state.page === "task")) {
    event.preventDefault();
    event.stopImmediatePropagation();
    void startTask(runtime).catch((error) => showRuntimeError(runtime, error));
  }
  if (action === "stop" && activeTaskId) {
    event.preventDefault();
    event.stopImmediatePropagation();
    void stopTask(runtime).catch((error) => showRuntimeError(runtime, error));
  }
  if (action === "test-llm") {
    event.preventDefault();
    event.stopImmediatePropagation();
    runtime.state.toast = "正在测试模型连接……";
    runtime.render();
    void testModelConnection(runtime).catch((error) => showRuntimeError(runtime, error));
  }
  if (action === "choose-root") {
    event.preventDefault();
    event.stopImmediatePropagation();
    void window.triMusicPrototypeBridge.chooseWorkspace().then(() => { runtime.state.workspaceRoot = "已选择工作数据根目录"; runtime.state.toast = "工作数据根目录已更新"; runtime.render(); }).catch((error) => showRuntimeError(runtime, error));
  }
  if (action === "continue") {
    event.preventDefault();
    event.stopImmediatePropagation();
    void window.triMusicPrototypeBridge.createSession().then(() => { runtime.state.page = "dashboard"; runtime.state.toast = "已创建新会话"; runtime.render(); }).catch((error) => showRuntimeError(runtime, error));
  }
}, true);

async function startTask(runtime) {
  const prompt = runtime.state.promptText.trim();
  debug("task-start", { promptLength: prompt.length, mode: runtime.state.mode });
  if (!prompt) { runtime.state.toast = "请先告诉 Agent 你想处理什么。"; runtime.render(); return; }
  runtime.state.conversationMode = true;
  runtime.state.promptText = "";
  runtime.state.processing = true;
  runtime.state.taskStatus = "处理中";
  runtime.state.progress = 8;
  runtime.state.agentMessages = [{ role: "user", text: prompt }, { role: "agent", text: "我先读取任务描述，生成结构化计划并检查可用能力。" }];
  runtime.state.toolEvents = ["生成结构化计划", "权限审批", "启动 Provider", "执行本地解密", "校验输出文件"].map((name, index) => ({ name, status: index === 0 ? "running" : "pending", detail: index === 0 ? "等待 Agent 计划" : "等待前一步完成" }));
  runtime.render();
  try {
    const result = await window.triMusicPrototypeBridge.startAgent(prompt, runtime.state.mode, (event) => {
      debug("agent-event", { taskId: event.taskId, type: event.type, status: event.status });
      const nestedStatus = event.payload?.event?.status;
      const progress = event.type === "plan_created" ? 18 : event.type === "approval_required" ? 28 : event.type === "runtime_started" ? 42 : event.type === "provider_event" ? (nestedStatus === "completed" ? 92 : 65) : event.type === "completed" ? 100 : runtime.state.progress;
      runtime.state.progress = progress;
      runtime.state.stepIndex = Math.min(5, Math.floor(progress / 20));
      runtime.state.toolEvents = runtime.state.toolEvents.map((item, index) => ({ ...item, status: index < runtime.state.stepIndex ? "done" : index === runtime.state.stepIndex ? "running" : "pending", detail: index < runtime.state.stepIndex ? "已完成" : index === runtime.state.stepIndex ? "Agent 正在处理" : "等待前一步完成" }));
      if (event.type === "completed" || event.type === "failed" || event.type === "cancelled") { runtime.state.processing = false; runtime.state.taskStatus = event.status === "completed" ? "成功" : event.status === "cancelled" ? "已停止" : "失败"; activeTaskId = null; }
      runtime.render();
    });
    activeTaskId = result.taskId;
    runtime.state.agentMessages = [...runtime.state.agentMessages, { role: "agent", text: "计划已创建，等待权限审批。" }];
    runtime.render();
  } catch (error) { activeTaskId = null; runtime.state.processing = false; runtime.state.taskStatus = "失败"; runtime.state.agentMessages = [...runtime.state.agentMessages, { role: "error", text: error instanceof Error ? error.message : "任务启动失败。" }]; runtime.render(); }
}

async function stopTask(runtime) { await window.triMusicPrototypeBridge.cancelAgent(); activeTaskId = null; runtime.state.processing = false; runtime.state.taskStatus = "已停止"; runtime.state.toast = "任务已停止"; runtime.render(); }

export async function testModelConnection(runtime) {
  debug("model-test-start", { model: runtime.state.modelConfig.model, baseUrl: runtime.state.modelConfig.baseUrl, apiKeyConfigured: Boolean(runtime.state.modelConfig.apiKey), networkEnabled: runtime.state.networkEnabled });
  if (!runtime.state.modelConfig.apiKey) throw new Error("请先填写 API Key。");
  if (!runtime.state.modelConfig.baseUrl) throw new Error("请先配置 API Base URL。");
  if (!runtime.state.networkEnabled) debug("model-test-network-disabled", "联网未开启，但模型测试将尝试直接连接");
  activeModel?.unsubscribe?.();
  runtime.state.toast = "正在测试模型连接……";
  runtime.state.llmMessages = [{ role: "notice", text: "正在测试模型连接……" }];
  runtime.render();
  try {
    debug("model-ipc-call", { networkEnabled: runtime.state.networkEnabled });
    activeModel = await window.triMusicPrototypeBridge.startModel(runtime.state.modelConfig, [{ role: "user", content: "请只回复：连接成功" }], runtime.state.mode, runtime.state.networkEnabled, (event) => {
      debug("model-event", { type: event.type, code: event.type === "error" ? event.code : undefined });
      if (event.type === "text_delta") runtime.state.llmMessages = [...runtime.state.llmMessages.filter((item) => item.role !== "notice"), { role: "assistant", text: event.text }];
      if (event.type === "response_completed") { runtime.state.llmTested = true; runtime.state.toast = "模型连接测试成功"; activeModel = null; }
      if (event.type === "error") { runtime.state.llmTested = false; runtime.state.llmMessages = [{ role: "error", text: event.message }]; activeModel = null; }
      runtime.render();
    });
  } catch (error) { debugError("model-test-error", error); runtime.state.llmTested = false; runtime.state.llmMessages = [{ role: "error", text: error instanceof Error ? error.message : "模型连接失败。" }]; runtime.state.toast = error instanceof Error ? error.message : "模型连接失败。"; runtime.render(); }
}

function showRuntimeError(runtime, error) {
  const message = error instanceof Error ? error.message : "操作失败。";
  debugError("operation-error", error);
  runtime.state.toast = message;
  runtime.render();
}

window.triMusicPrototypeModelTest = testModelConnection;
