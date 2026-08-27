/** Action handler dispatcher for prototype UI.
 * Extracted from app.js for SRP.
 */

const PERMISSION_MODE_REVERSE = { "受限": "restricted", "标准": "standard", "完全访问": "full" };

export function createActionHandlers(state, root, deps) {
  const { toast, render, debug, addFile, startProcessing, stopProcessing, saveToMain, startLlmResponse, startLlmRetry, interruptLlm } = deps;

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
    if (action === "llm-send") {
      if (!state.promptText.trim()) return toast("先告诉 TriMusicAgent 你的想法");
      state.llmChatSent = true;
      state.lastLlmPrompt = state.promptText.trim();
      state.llmMessages = [...state.llmMessages, { role: "user", text: state.lastLlmPrompt }];
      state.promptText = "";
      /error|403|失败|断网/i.test(state.lastLlmPrompt) ? startLlmRetry() : startLlmResponse();
      return;
    }
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

  return { handleAction };
}
