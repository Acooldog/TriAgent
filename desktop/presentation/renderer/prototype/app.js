import { createState, loadSettingsFromMain } from "./data.js";
import { renderApp } from "./ui.js";
import { createStreamSession, retryConnection, streamText } from "./llm-stream.js";
const root = document.querySelector("#app");
const state = createState();
const debug = (event, payload = {}) => console.info(`[TriMusicAgent][prototype] ${event}`, payload);
window.triMusicPrototypeRuntime = { state, render: () => render() };

const PERMISSION_MODE_REVERSE = { "受限": "restricted", "标准": "standard", "完全访问": "full" };

async function saveToMain(partial) {
  debug("save-settings-to-main", Object.keys(partial));
  try {
    const updated = await window.triMusicAgent.updateAppSettings(partial);
    debug("save-settings-saved", updated ? "ok" : "failed");
    return updated;
  } catch (error) {
    console.error("[TriMusicAgent][prototype] 保存设置失败", error instanceof Error ? error.message : error);
    return null;
  }
}

debug("init-loading-settings");
loadSettingsFromMain(state).then(() => { debug("settings-loaded", { networkEnabled: state.networkEnabled, mode: state.mode }); render(); });

let timer = null;
let typewriterTimer = null;
let llmStreamSession = null;
const headlinePhrases = ["我能为你做什么", "想解密音乐吗？", "bilibili关注牢大了吗"];
const typewriter = { phrase: 0, index: 0, deleting: false, holdUntil: 0 };
function render() {
  const currentStream = root.querySelector(".conversation-stream, .llm-chat-scroll");
  const previousScrollTop = currentStream?.scrollTop || 0;
  const previousScrollHeight = currentStream?.scrollHeight || 0;
  const previousClientHeight = currentStream?.clientHeight || 0;
  const wasNearBottom = !currentStream || previousScrollHeight - previousScrollTop - previousClientHeight < 56;
  root.innerHTML = renderApp(state);
  enhancePromptEditors();
  enhancePageChrome();
  enhanceScrollbars();
  root.querySelectorAll(".aside-task .task-mark").forEach((mark, index) => {
    mark.textContent = state.history[index]?.status === "成功" ? "OK" : "error";
  });
  if (state.page === "settings" && state.settingsTab === "data" && !root.querySelector("[data-auto-compression]")) {
    const anchor = root.querySelector(".settings-content .setting-switch:nth-of-type(2)");
    if (anchor) {
      const control = document.createElement("label");
      control.className = "setting-switch";
      control.dataset.autoCompression = "true";
      control.innerHTML = `<span>自动压缩</span><input type="checkbox" data-action="toggle-auto-compress" ${state.autoCompression ? "checked" : ""} /><i></i>`;
      anchor.after(control);
    }
  }
  if (state.page === "settings" && state.settingsTab === "limits" && !root.querySelector("[data-context-threshold]")) {
    const grid = root.querySelector(".settings-content .field-grid");
    if (grid) {
      const field = document.createElement("label");
      field.dataset.contextThreshold = "true";
      field.innerHTML = `上下文压缩阈值（%）<input data-input="context-threshold" type="number" min="50" max="95" value="${state.compressionThreshold}" /><small>达到此比例后，保留最近消息并压缩较早上下文。</small>`;
      grid.append(field);
    }
  }
  if (state.page === "settings" && state.settingsTab === "model" && !root.querySelector("[data-real-model-fields]")) {
    const block = root.querySelector(".settings-content .setting-block");
    if (block) {
      const fields = document.createElement("div");
      fields.dataset.realModelFields = "true";
      fields.className = "field-grid real-model-fields";
      fields.innerHTML = `<label>API Key<input data-input="model-api-key" type="password" value="${state.modelConfig.apiKey || ""}" autocomplete="off" /></label><label>思考模式<select data-input="model-thinking"><option value="enabled" ${state.modelConfig.thinking === "enabled" ? "selected" : ""}>开启深度思考</option><option value="disabled" ${state.modelConfig.thinking !== "enabled" ? "selected" : ""}>关闭深度思考</option></select></label><label>最大 Token<input data-input="model-max-tokens" type="number" min="1" step="1" value="${state.modelConfig.maxTokens || 4096}" /></label><label>Temperature<input data-input="model-temperature" type="number" min="0" max="2" step="0.1" value="${state.modelConfig.temperature ?? 0.6}" /></label>`;
      block.append(fields);
    }
  }
  root.querySelectorAll('[data-page="onboarding"]').forEach((element) => { element.removeAttribute("data-page"); element.dataset.action = "open-data-settings"; });
  syncTypewriter();
  const nextStream = root.querySelector(".conversation-stream, .llm-chat-scroll");
  if (nextStream) nextStream.scrollTop = wasNearBottom ? nextStream.scrollHeight : previousScrollTop;
}
function updateBottomButton() { const scroll = root.querySelector(".llm-chat-scroll, .conversation-stream"); const button = root.querySelector(".to-bottom-button"); if (scroll && button) button.classList.toggle("is-visible", scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight > 80); }
function enhanceScrollbars() { root.querySelectorAll(".llm-chat-scroll, .conversation-stream").forEach((scroll) => { let hideTimer; scroll.addEventListener("scroll", () => { scroll.classList.add("is-scrolling"); updateBottomButton(); window.clearTimeout(hideTimer); hideTimer = window.setTimeout(() => scroll.classList.remove("is-scrolling"), 700); }, { passive: true }); }); updateBottomButton(); }
function enhancePageChrome() {
  if (state.page === "dashboard" && !state.conversationMode) {
    const title = root.querySelector(".writer-title h2");
    if (title) title.textContent = "TriMusicAgent";
    const subtitle = root.querySelector(".writer-title p");
    if (subtitle) subtitle.innerHTML = `<span class="subtitle-typewriter" aria-live="polite"></span>`;
    const prompt = root.querySelector(".prompt-text-input");
    if (prompt) { prompt.dataset.placeholder = "告诉 TriMusicAgent 你想怎么处理音乐，例如：扫描 QQ 音乐文件并转成 MP3"; prompt.setAttribute("aria-label", "告诉 TriMusicAgent 你想怎么处理音乐，例如：扫描 QQ 音乐文件并转成 MP3"); }
  }
  if (state.page === "llm") {
    const llmBack = root.querySelector(".llm-back");
    if (llmBack) { llmBack.dataset.action = "route-back"; llmBack.removeAttribute("data-page"); }
    root.querySelector(".llm-chat-number")?.remove();
    root.querySelector(".llm-thinking")?.remove();
    if (!state.llmChatSent) root.querySelector(".llm-chat-message.assistant")?.remove();
    const input = root.querySelector(".llm-input");
    if (input) { input.dataset.placeholder = "向 TriMusicAgent 发送你的想法"; input.setAttribute("aria-label", "向 TriMusicAgent 发送你的想法"); }
    const message = root.querySelector(".llm-chat-message.user p");
    if (message && state.lastLlmPrompt) message.textContent = state.lastLlmPrompt;
  }
  if (state.conversationMode) {
    root.querySelector(".conversation-kimi-actions [data-action=back-home]")?.remove();
    const conversationBack = root.querySelector(".conversation-kimi-page .llm-back");
    if (conversationBack) conversationBack.dataset.action = "route-back";
    const input = root.querySelector(".conversation-kimi-page .llm-input");
    if (input) { input.dataset.placeholder = "向 TriMusicAgent 发送你的想法"; input.setAttribute("aria-label", "向 TriMusicAgent 发送你的想法"); }
  }
  root.querySelectorAll(".llm-path-chip").forEach((chip, index) => {
    if (chip.querySelector("button")) return;
    const remove = document.createElement("button");
    remove.type = "button"; remove.textContent = "×"; remove.dataset.action = "remove-path"; remove.dataset.pathIndex = String(index); remove.setAttribute("aria-label", "删除路径");
    chip.append(remove);
  });
  root.querySelectorAll(".llm-composer-footer").forEach((footer) => {
    footer.querySelector(":scope > span:not(.context-meter)")?.remove();
    if (!footer.querySelector(".llm-context-controls")) {
      const controls = document.createElement("div");
      controls.className = "llm-context-controls";
      controls.innerHTML = `<button class="llm-context-mode" data-action="cycle-mode">${state.mode}模式⌄</button><button class="llm-context-network" data-action="toggle-network">${state.networkEnabled ? "联网" : "离线"}</button>`;
      footer.insertBefore(controls, footer.querySelector(".llm-send"));
    }
  });
}
function enhancePromptEditors() {
  root.querySelectorAll(".prompt-editor, .conversation-composer").forEach((editor) => {
    const textarea = editor.querySelector("textarea[data-input=prompt]");
    if (!textarea) return;
    const input = document.createElement("div");
    input.className = "prompt-text-input";
    input.contentEditable = "true";
    input.setAttribute("role", "textbox");
    input.setAttribute("aria-multiline", "true");
    input.setAttribute("aria-label", textarea.getAttribute("placeholder") || "任务描述");
    input.dataset.input = "prompt";
    input.dataset.placeholder = textarea.getAttribute("placeholder") || "告诉 Agent 你想怎么处理音乐";
    input.textContent = textarea.value;
    textarea.replaceWith(input);
    const footer = editor.querySelector(".prompt-footer");
    const count = footer?.querySelector("span");
    if (count) count.className = "prompt-count";
    const pathRow = document.createElement("div");
    pathRow.className = "prompt-path-row";
    pathRow.innerHTML = `${state.attachedPaths.map((path, index) => `<span class="path-chip"><span>${path}</span><button data-action="remove-path" data-path-index="${index}" aria-label="删除路径">×</button></span>`).join("")}<button class="add-path-button" data-action="add-path">＋ 添加路径</button>`;
    editor.prepend(pathRow);
  });
}
function syncTypewriter() {
  const active = state.page === "dashboard" && !state.conversationMode;
  if (!active) { if (typewriterTimer) window.clearInterval(typewriterTimer); typewriterTimer = null; return; }
  const current = root.querySelector(".subtitle-typewriter");
  if (current) current.textContent = headlinePhrases[typewriter.phrase].slice(0, typewriter.index);
  if (typewriterTimer) return;
  typewriterTimer = window.setInterval(() => {
    const element = root.querySelector(".subtitle-typewriter");
    if (!element) return;
    const phrase = headlinePhrases[typewriter.phrase];
    if (!typewriter.deleting && typewriter.index < phrase.length) typewriter.index += 1;
    else if (!typewriter.deleting) { typewriter.holdUntil = Date.now() + 10000; typewriter.deleting = true; }
    else if (Date.now() < typewriter.holdUntil) return;
    else if (typewriter.index > 0) typewriter.index -= 1;
    else { typewriter.deleting = false; typewriter.phrase = (typewriter.phrase + 1) % headlinePhrases.length; }
    element.textContent = phrase.slice(0, typewriter.index);
  }, 120);
}
function toast(message) {
  state.toast = message;
  render();
  window.setTimeout(() => {
    if (state.toast === message) { state.toast = ""; render(); }
  }, 2200);
}
function startProcessing() {
  if (timer && state.processing) return toast("任务已经在处理中");
  if (timer) { window.clearInterval(timer); timer = null; }
  if (state.page === "dashboard" && !state.promptText.trim()) return toast("先告诉 Agent 你想处理什么");
  if (state.page === "dashboard" && !state.conversationMode) {
    const prompt = state.promptText.trim();
    state.conversationMode = true;
    state.promptText = "";
    state.agentMessages = [{ role: "user", text: prompt }, { role: "agent", text: "我先读取你的任务描述，再检查文件格式和可用工具。" }];
    state.toolEvents = [
      { name: "读取任务描述", status: "done", detail: "已解析处理目标" },
      { name: "扫描音乐文件", status: "running", detail: "等待扫描结果" },
      { name: "选择解密器", status: "pending", detail: "等待前一步完成" },
      { name: "运行 FFmpeg", status: "pending", detail: "等待前一步完成" },
      { name: "校验输出文件", status: "pending", detail: "等待前一步完成" },
    ];
    state.processStep = 1;
    state.progress = 12;
  } else if (state.page === "dashboard") {
    const prompt = state.promptText.trim();
    state.promptText = "";
    state.agentMessages = [...state.agentMessages, { role: "user", text: prompt }, { role: "agent", text: "收到补充说明，我会把它纳入当前任务并重新检查工具链。" }];
    state.toolEvents = [
      { name: "读取补充说明", status: "done", detail: "已合并到当前任务" },
      { name: "重新检查文件格式", status: "running", detail: "等待扫描结果" },
      { name: "调整处理方案", status: "pending", detail: "等待前一步完成" },
      { name: "校验输出文件", status: "pending", detail: "等待前一步完成" },
    ];
    state.processStep = 1;
    state.progress = 12;
    state.stepIndex = 0;
  }
  state.processing = true;
  state.taskStatus = "处理中";
  state.progress = Math.max(state.progress, 42);
  state.stepIndex = Math.min(state.stepIndex, 2);
  toast("已开始模拟处理任务");
  timer = window.setInterval(() => {
    state.progress += 14;
    if (state.progress > 100) state.progress = 100;
    state.stepIndex = Math.min(5, Math.floor(state.progress / 18));
    state.processStep = Math.min(state.toolEvents.length - 1, Math.floor(state.progress / 22));
    state.toolEvents = state.toolEvents.map((event, index) => ({
      ...event,
      status: index < state.processStep ? "done" : index === state.processStep ? "running" : "pending",
      detail: index < state.processStep ? "已完成模拟调用" : index === state.processStep ? "Agent 正在处理" : "等待前一步完成",
    }));
    if (state.progress > 35 && state.agentMessages.length === 2) state.agentMessages = [...state.agentMessages, { role: "agent", text: "已识别输入文件，正在按平台匹配解密器和转码工具。" }];
    if (state.progress > 70 && state.agentMessages.length === 3) state.agentMessages = [...state.agentMessages, { role: "agent", text: "工具链已准备完成，接下来校验输出文件。" }];
    state.queue = state.queue.map((file, index) => index === 0 ? { ...file, status: state.progress >= 100 ? "已完成" : "处理中" } : file);
    if (state.progress >= 100) {
      window.clearInterval(timer);
      timer = null;
      state.processing = false;
      state.taskStatus = "成功";
      state.toolEvents = state.toolEvents.map((event) => ({ ...event, status: "done", detail: "已完成模拟调用" }));
      state.agentMessages = [...state.agentMessages, { role: "agent", text: "任务已完成。所有操作均为模拟数据，没有执行真实解密或命令。" }];
      state.history = [{ title: "周杰伦音乐批量处理", date: "刚刚", total: state.queue.length, success: state.queue.length, failed: 0, status: "成功", time: "00:02:35" }, ...state.history];
      toast("模拟任务已完成");
    }
    render();
  }, 900);
  render();
}
function stopProcessing() {
  if (timer) window.clearInterval(timer);
  timer = null;
  state.processing = false;
  state.taskStatus = "已停止";
  toast("任务已停止，未执行真实操作");
}
function replyFor(prompt) { if (prompt.trim() === "1") return "你发送了“1”，我可以先陪你做一次完整的 TriMusicAgent 流程测试。你可以继续输入音乐文件路径、想解密的平台、输出格式，或者直接描述你想得到的结果。我会把用户消息放在右侧，把 TriMusicAgent 的回复放在左侧，并持续把新消息追加到滚动容器底部。\n\n你也可以测试三种模式：受限模式会先提示敏感操作，标准模式会在需要时请求确认，完全访问模式会自动执行允许范围内的任务。联网检索模式会在消息流中插入状态分隔线，方便你确认当前上下文。"; return `我收到你的需求：“${prompt}”。这是一个未接入真实模型的原型回复。你可以继续补充文件、路径、平台、输出格式或错误信息，我会把每次输入追加为新的消息，并模拟 TriMusicAgent 的处理过程。`; }
function startLlmResponse() {
  llmStreamSession?.abort();
  const fullText = replyFor(state.lastLlmPrompt);
  state.llmStreaming = { text: fullText, index: 0 };
  state.contextUsage = Math.min(96, state.contextUsage + Math.max(6, Math.ceil(fullText.length / 220)));
  llmStreamSession = createStreamSession();
  render();
  streamText(fullText, { session: llmStreamSession, delay: state.llmOutputSpeed, onChunk: (index) => { if (state.llmStreaming) { state.llmStreaming.index = index; updateLlmStreamDom(index); } }, onDone: () => { state.llmMessages = [...state.llmMessages, { role: "assistant", text: fullText }]; state.llmStreaming = null; llmStreamSession = null; if (state.contextUsage >= state.compressionThreshold) compressLlmContext(); render(); }, onAbort: (index) => { state.llmMessages = [...state.llmMessages, { role: "assistant", text: fullText.slice(0, index) || "TriMusicAgent 已被打断。" }]; state.llmStreaming = null; llmStreamSession = null; render(); } });
}
function startLlmRetry() { llmStreamSession?.abort(); llmStreamSession = createStreamSession(); state.llmRetry = { attempt: 0, max: 5 }; render(); retryConnection(async () => { throw new Error("unexpected status 403 Forbidden：模型连接失败或余额不足（request id: prototype-403）"); }, { session: llmStreamSession, maxAttempts: 5, onAttempt: (attempt, max) => { state.llmRetry = { attempt, max }; render(); } }).catch((error) => { if (error.name === "AbortError") return; state.llmRetry = null; state.llmMessages = [...state.llmMessages, { role: "error", text: error.message }]; llmStreamSession = null; render(); }); }
function updateLlmStreamDom(index) { const paragraph = root.querySelector(".llm-chat-message.streaming p"); if (paragraph && state.llmStreaming) { const caret = paragraph.querySelector(".streaming-caret"); paragraph.textContent = state.llmStreaming.text.slice(0, index); if (caret) paragraph.append(caret); } const meter = root.querySelector(".context-meter"); if (meter) { meter.style.setProperty("--usage", `${state.contextUsage}%`); const label = meter.querySelector("b"); if (label) label.textContent = `${state.contextUsage}%`; } updateBottomButton(); }
function compressLlmContext() { const keep = state.llmMessages.slice(-4); state.contextUsage = Math.max(30, Math.round(state.contextUsage * .48)); state.llmMessages = [{ role: "notice", text: `上下文已自动压缩，保留最近对话，当前使用量 ${state.contextUsage}%` }, ...keep]; }
function interruptLlm() { if (!state.llmStreaming && !state.llmRetry) return; llmStreamSession?.abort(); if (state.llmRetry) { state.llmRetry = null; llmStreamSession = null; render(); } }
function addFile(folder = false) {
  const suffix = state.queue.length + 1;
  const newFiles = folder ? [
    { id: `f${Date.now()}a`, title: `新歌单-${suffix}.ncm`, artist: "模拟艺术家", platform: "网易云音乐", input: "ncm", output: "flac", size: "12.40 MB", status: "待处理", cover: "cover-f" },
    { id: `f${Date.now()}b`, title: `现场录音-${suffix}.mgg`, artist: "模拟艺术家", platform: "QQ 音乐", input: "mgg", output: "flac", size: "18.20 MB", status: "待处理", cover: "cover-g" },
  ] : [{ id: `f${Date.now()}`, title: `新增音乐-${suffix}.ncm`, artist: "模拟艺术家", platform: "网易云音乐", input: "ncm", output: "flac", size: "11.20 MB", status: "待处理", cover: "cover-f" }];
  state.queue = [...state.queue, ...newFiles];
  toast(folder ? "已添加模拟文件夹（2 个文件）" : "已添加模拟音乐文件");
}
function handleAction(action, element) {
  if (action === "new-task") { state.page = "dashboard"; state.queue = []; toast("已新建空处理任务"); }
  if (action === "add-file") addFile(false);
  if (action === "add-folder") addFile(true);
  if (action === "start") startProcessing();
  if (action === "stop") stopProcessing();
  if (action === "back-home") { state.page = "dashboard"; state.conversationMode = false; toast("已返回主页，任务仍在进行"); }
  if (action === "resume-conversation") { state.page = "dashboard"; state.conversationMode = true; render(); return; }
  if (action === "retry") { state.taskStatus = "处理中"; state.progress = 38; state.stepIndex = 1; toast("已重试失败项（模拟）"); }
  if (action === "clear-queue") { state.queue = []; toast("已清空模拟队列"); }
  if (action === "remove-file") { state.queue = state.queue.filter((file) => file.id !== element.dataset.id); toast("已从队列移除"); }
  if (action === "toggle-network") {
    state.networkEnabled = !state.networkEnabled;
    debug("toggle-network", state.networkEnabled);
    void saveToMain({ network: { enabled: state.networkEnabled } });
    if (state.page === "llm") state.llmMessages = [...state.llmMessages, { role: "notice", text: `已切换为${state.networkEnabled ? "联网检索模式" : "离线模式"}` }];
    else toast(state.networkEnabled ? "已开启联网" : "已关闭联网");
  }
  if (action === "cycle-mode") { state.modeMenuOpen = !state.modeMenuOpen; render(); return; }
  if (action === "select-mode") {
    state.mode = element.dataset.mode;
    state.modeMenuOpen = false;
    debug("select-mode", state.mode);
    const mapped = PERMISSION_MODE_REVERSE[state.mode];
    if (mapped) void saveToMain({ security: { permissionMode: mapped } });
    if (state.page === "llm") state.llmMessages = [...state.llmMessages, { role: "notice", text: `已切换为${state.mode}模式` }];
    else toast(`已切换为${state.mode}模式`);
  }
  if (action === "route-back") { if (state.routeHistory.length > 1) state.routeHistory.pop(); state.page = state.routeHistory[state.routeHistory.length - 1] || "dashboard"; state.conversationMode = false; }
  if (action === "toggle-event") { const body = element.parentElement.querySelector(".event-body"); body.classList.toggle("is-hidden"); element.setAttribute("aria-expanded", String(!body.classList.contains("is-hidden"))); return; }
  if (action === "toggle-conversation-log") { const container = element.closest(".execution-card, .conversation-kimi-execution, .llm-execution-sticky"); const body = container?.querySelector(".tool-events, .conversation-kimi-events, .llm-execution-events"); if (!body) return; state.executionCollapsed = !state.executionCollapsed; container.classList.toggle("is-collapsed", state.executionCollapsed); element.textContent = state.executionCollapsed ? "展开" : "收起"; return; }
  if (action === "collapse-all") { document.querySelectorAll(".event-body").forEach((body) => body.classList.add("is-hidden")); return; }
  if (action === "approval") state.modal = "approval";
  if (action === "close-modal") state.modal = null;
  if (["allow-once", "allow-task"].includes(action)) { state.modal = null; state.mode = action === "allow-task" ? "完全访问" : "标准"; toast(action === "allow-task" ? "已允许本任务" : "已允许一次"); }
  if (action === "deny") { state.modal = null; toast("已拒绝敏感操作"); }
  if (action === "choose-root") toast("原型中已模拟选择 D:\\TriMusicAgent\\Data");
  if (action === "continue") { state.page = "dashboard"; toast("工作数据根目录已就绪（模拟）"); }
  if (action === "open-data-settings") { state.routeHistory = [...state.routeHistory, "settings"]; state.page = "settings"; state.settingsTab = "data"; }
  if (action === "diagnose") toast("完整诊断完成：7 项正常，1 项提示");
  if (action === "save-settings") {
    debug("save-settings-click");
    void (async () => {
      try {
        const result = await window.triMusicAgent.saveModelConfig(state.modelConfig);
        debug("save-settings-result", result);
        const { apiKey: _apiKey, ...rest } = state.modelConfig;
        await saveToMain({ model: { defaultConfig: rest } });
        toast("设置已保存");
      } catch (error) { toast(error instanceof Error ? error.message : "设置保存失败。"); }
    })();
  }
  if (action === "select-llm") { state.llmModel = element.dataset.model; state.llmTested = false; toast(`已选择 ${state.llmModel}`); }
  if (action === "test-llm") { void window.triMusicPrototypeModelTest?.(window.triMusicPrototypeRuntime).catch((error) => toast(error instanceof Error ? error.message : "模型连接测试失败。")); }
  if (action === "reset-llm") {
    state.llmModel = "DeepSeek-R1";
    state.llmProvider = "OpenAI-compatible";
    state.llmTested = false;
    debug("reset-llm");
    void saveToMain({ model: { defaultConfig: { ...state.modelConfig, model: "DeepSeek-R1" } } });
    toast("已恢复推荐模型配置");
  }
  if (action === "compress") { state.compressionDone = true; toast("会话压缩完成，原始消息已保留"); }
  if (action === "toast") toast(element.dataset.message || "操作已完成");
  if (action === "agent-note") toast("Agent 已记录你的补充说明");
  if (action === "use-suggestion") { state.promptText = element.dataset.suggestion || ""; toast("已填入示例任务"); }
  if (action === "add-path") { state.attachedPaths = [...state.attachedPaths, "D:\\TriMusicAgent\\Music"]; toast("已添加模拟路径"); }
  if (action === "remove-path") { state.attachedPaths = state.attachedPaths.filter((_, index) => index !== Number(element.dataset.pathIndex)); toast("已移除路径"); }
  if (action === "llm-send") { if (!state.promptText.trim()) return toast("先告诉 TriMusicAgent 你的想法"); state.llmChatSent = true; state.lastLlmPrompt = state.promptText.trim(); state.llmMessages = [...state.llmMessages, { role: "user", text: state.lastLlmPrompt }]; state.promptText = ""; /error|403|失败|断网/i.test(state.lastLlmPrompt) ? startLlmRetry() : startLlmResponse(); return; }
  if (action === "interrupt-llm") { interruptLlm(); return; }
  if (action === "retry-llm") { startLlmRetry(); return; }
  if (action === "scroll-bottom") { const scroll = root.querySelector(".llm-chat-scroll, .conversation-stream"); if (scroll) scroll.scrollTo({ top: scroll.scrollHeight, behavior: "smooth" }); return; }
  if (action === "toggle-auto-compress") {
    state.autoCompression = !state.autoCompression;
    debug("toggle-auto-compress", state.autoCompression);
    toast(state.autoCompression ? "已开启自动压缩" : "已关闭自动压缩");
  }
  render();
}
root.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action], [data-page], [data-settings-tab], [data-mode]");
  if (!target) return;
  if (target.dataset.page) { if (target.dataset.page !== state.page) state.routeHistory = [...state.routeHistory, target.dataset.page]; state.page = target.dataset.page; render(); return; }
  if (target.dataset.settingsTab) { state.settingsTab = target.dataset.settingsTab; render(); return; }
  if (target.dataset.mode) { handleAction("select-mode", target); return; }
  handleAction(target.dataset.action, target);
});
root.addEventListener("input", (event) => {
  const target = event.target;
  if (target.dataset.input === "prompt") {
    state.promptText = target.value ?? target.textContent ?? "";
    const counter = root.querySelector(".prompt-count");
    if (counter) counter.textContent = `${state.promptText.length} / 500`;
  }
  if (target.dataset.input === "library-query") { state.libraryQuery = target.value; render(); }
  if (target.dataset.input === "library-platform") { state.libraryPlatform = target.value; render(); }
  if (target.dataset.input === "library-format") { state.libraryFormat = target.value; render(); }
  if (target.dataset.input === "context-threshold") {
    state.compressionThreshold = Math.max(50, Math.min(95, Number(target.value) || 80));
    debug("context-threshold-change", state.compressionThreshold);
  }
  if (target.dataset.input === "model-api-key") {
    state.modelConfig.apiKey = target.value;
    debug("model-api-key-change");
  }
  if (target.dataset.input === "model-name") {
    state.modelConfig.model = target.value;
    debug("model-name-change", state.modelConfig.model);
    void saveToMain({ model: { defaultConfig: { ...state.modelConfig } } });
  }
  if (target.dataset.input === "model-base-url") {
    state.modelConfig.baseUrl = target.value;
    debug("model-base-url-change", state.modelConfig.baseUrl);
    void saveToMain({ model: { defaultConfig: { ...state.modelConfig } } });
  }
  if (target.dataset.input === "model-thinking") {
    state.modelConfig.thinking = target.value === "enabled" ? "enabled" : "disabled";
    debug("model-thinking-change", state.modelConfig.thinking);
    void saveToMain({ model: { defaultConfig: { ...state.modelConfig } } });
  }
  if (target.dataset.input === "model-max-tokens") {
    state.modelConfig.maxTokens = Math.max(1, Number(target.value) || 4096);
    debug("model-max-tokens-change", state.modelConfig.maxTokens);
    void saveToMain({ model: { defaultConfig: { ...state.modelConfig } } });
  }
  if (target.dataset.input === "model-temperature") {
    state.modelConfig.temperature = Math.max(0, Math.min(2, Number(target.value) || 0.6));
    debug("model-temperature-change", state.modelConfig.temperature);
    void saveToMain({ model: { defaultConfig: { ...state.modelConfig } } });
  }
});
root.addEventListener("keydown", (event) => { const target = event.target; if (!target.matches(".llm-input, .prompt-text-input") || event.key !== "Enter" || event.shiftKey) return; event.preventDefault(); handleAction(target.matches(".llm-input") ? (state.conversationMode ? "start" : state.llmStreaming ? "interrupt-llm" : "llm-send") : "start", target); });
render();
