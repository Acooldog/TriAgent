/** DOM enhancement helpers for prototype UI.
 * Extracted from app.js for SRP.
 */

export function createDomEnhancers(root, state, { toast, render, debug }) {
  function updateBottomButton() {
    const scroll = root.querySelector(".llm-chat-scroll, .conversation-stream");
    const button = root.querySelector(".to-bottom-button");
    if (scroll && button) {
      button.classList.toggle("is-visible", scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight > 80);
    }
  }

  function enhanceScrollbars() {
    root.querySelectorAll(".llm-chat-scroll, .conversation-stream").forEach((scroll) => {
      let hideTimer;
      scroll.addEventListener("scroll", () => {
        scroll.classList.add("is-scrolling");
        updateBottomButton();
        window.clearTimeout(hideTimer);
        hideTimer = window.setTimeout(() => scroll.classList.remove("is-scrolling"), 700);
      }, { passive: true });
    });
    updateBottomButton();
  }

  function enhancePageChrome() {
    if (state.page === "dashboard" && !state.conversationMode) {
      const title = root.querySelector(".writer-title h2");
      if (title) title.textContent = "TriMusicAgent";
      const subtitle = root.querySelector(".writer-title p");
      if (subtitle) subtitle.innerHTML = `<span class="subtitle-typewriter" aria-live="polite"></span>`;
      const prompt = root.querySelector(".prompt-text-input");
      if (prompt) {
        prompt.dataset.placeholder = "告诉 TriMusicAgent 你想怎么处理音乐，例如：扫描 QQ 音乐文件并转成 MP3";
        prompt.setAttribute("aria-label", "告诉 TriMusicAgent 你想怎么处理音乐，例如：扫描 QQ 音乐文件并转成 MP3");
      }
    }
    if (state.page === "llm") {
      const llmBack = root.querySelector(".llm-back");
      if (llmBack) { llmBack.dataset.action = "route-back"; llmBack.removeAttribute("data-page"); }
      root.querySelector(".llm-chat-number")?.remove();
      root.querySelector(".llm-thinking")?.remove();
      if (!state.llmChatSent) root.querySelector(".llm-chat-message.assistant")?.remove();
      const input = root.querySelector(".llm-input");
      if (input) {
        input.dataset.placeholder = "向 TriMusicAgent 发送你的想法";
        input.setAttribute("aria-label", "向 TriMusicAgent 发送你的想法");
      }
      const message = root.querySelector(".llm-chat-message.user p");
      if (message && state.lastLlmPrompt) message.textContent = state.lastLlmPrompt;
    }
    if (state.conversationMode) {
      root.querySelector(".conversation-kimi-actions [data-action=back-home]")?.remove();
      const conversationBack = root.querySelector(".conversation-kimi-page .llm-back");
      if (conversationBack) conversationBack.dataset.action = "route-back";
      const input = root.querySelector(".conversation-kimi-page .llm-input");
      if (input) {
        input.dataset.placeholder = "向 TriMusicAgent 发送你的想法";
        input.setAttribute("aria-label", "向 TriMusicAgent 发送你的想法");
      }
    }
    root.querySelectorAll(".llm-path-chip").forEach((chip, index) => {
      if (chip.querySelector("button")) return;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.dataset.action = "remove-path";
      remove.dataset.pathIndex = String(index);
      remove.setAttribute("aria-label", "删除路径");
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

  return { updateBottomButton, enhanceScrollbars, enhancePageChrome, enhancePromptEditors };
}

export function createTypewriter(root, state, { toast, render }) {
  let timer = null;
  const headlinePhrases = ["我能为你做什么", "想解密音乐吗？", "bilibili关注牢大了吗"];
  const typewriter = { phrase: 0, index: 0, deleting: false, holdUntil: 0 };

  function sync() {
    const active = state.page === "dashboard" && !state.conversationMode;
    if (!active) {
      if (timer) window.clearInterval(timer);
      timer = null;
      return;
    }
    const current = root.querySelector(".subtitle-typewriter");
    if (current) current.textContent = headlinePhrases[typewriter.phrase].slice(0, typewriter.index);
    if (timer) return;
    timer = window.setInterval(() => {
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

  return { sync };
}
