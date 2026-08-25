import { useEffect, useRef } from "react";
import type { UseAppStateResult } from "../hooks/useAppState";

export function LlmChat(state: UseAppStateResult) {
  const {
    llmMessages, llmStreaming, llmThinking, llmDebugText, promptText, setPromptText,
    mode, networkEnabled, modeMenuOpen, setModeMenuOpen,
    conversationMode, routeBack, executionCollapsed, setExecutionCollapsed,
    progress, toolEvents, contextUsage, toggleNetwork, selectMode,
    sendPrompt, attachedPaths, setAttachedPaths, llmRetry,
    stopProcessing, dashboardPromptRef,
  } = state;

  const editorRef = useRef<HTMLDivElement>(null);
  const isComposingRef = useRef(false);
  const lastExternalValueRef = useRef(promptText);

  useEffect(() => {
    if (!editorRef.current) return;
    if (promptText !== lastExternalValueRef.current && !isComposingRef.current) {
      editorRef.current.innerText = promptText;
      lastExternalValueRef.current = promptText;
    }
  }, [promptText]);

  const handleInput = (e: React.FormEvent<HTMLDivElement>) => {
    if (isComposingRef.current) return;
    const text = (e.target as HTMLDivElement).innerText;
    setPromptText(text);
    lastExternalValueRef.current = text;
  };

  const handleCompositionStart = () => {
    isComposingRef.current = true;
  };

  const handleCompositionEnd = (e: React.CompositionEvent<HTMLDivElement>) => {
    isComposingRef.current = false;
    const text = (e.target as HTMLDivElement).innerText;
    setPromptText(text);
    lastExternalValueRef.current = text;
  };

  useEffect(() => {
    if (dashboardPromptRef?.current) {
      const text = dashboardPromptRef.current;
      dashboardPromptRef.current = null;
      setPromptText(text);
      lastExternalValueRef.current = text;
      requestAnimationFrame(() => {
        sendPrompt();
      });
    }
  }, []);

  const isTaskMode = conversationMode;

  const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt", '"': "&quot;", "'": "&#39;" }[c]!));

  const messages = isTaskMode
    ? state.agentMessages.map((message) =>
      message.role === "user" ? (
        <div key={`u-${message.text}`} className="llm-chat-message user"><p>{message.text}</p><span className="llm-avatar user-avatar">你</span></div>
      ) : (
        <div key={`a-${message.text}`} className="llm-chat-message assistant"><span className="llm-avatar">T</span><div><p>{message.text}</p></div></div>
      )
    ).join("")
    : llmMessages.map((message, index) => {
      if (message.role === "error") {
        return `<div class="llm-error-message"><div><strong>AI 连接错误</strong><p>${esc(message.text)}</p></div><button>重试</button></div>`;
      }
      if (message.role === "notice") {
        return `<div class="llm-system-notice"><span>${esc(message.text)}</span></div>`;
      }
      return message.role === "user"
        ? `<div class="llm-chat-message user"><p>${esc(message.text)}</p><span class="llm-avatar user-avatar">你</span></div>`
        : `<div class="llm-chat-message assistant"><span class="llm-avatar">T</span><div><p>${esc(message.text)}</p></div></div>`;
    }).join("");

  const eventsHtml = toolEvents.map((event, index) =>
    `<div class="tool-event ${event.status}"><span class="tool-event-index">${index + 1}</span><div><b>${esc(event.name)}</b><small>${esc(event.detail)}</small></div><span class="tool-event-status">${event.status === "done" ? "完成" : event.status === "running" ? "进行中" : "等待"}</span></div>`
  ).join("");

  const executionHtml = isTaskMode
    ? `<div class="llm-execution-sticky ${executionCollapsed ? "is-collapsed" : ""}"><div class="llm-execution-head"><strong>Agent 执行过程</strong><span>${progress}%</span><button onClick=${() => setExecutionCollapsed(!executionCollapsed)}>${executionCollapsed ? "展开" : "收起"}</button></div><div class="execution-bar"><i style="width:${progress}%"></i></div><div class="llm-execution-events">${eventsHtml}</div></div>`
    : "";

  const thinkingHtml = llmThinking && !llmStreaming
    ? `<div class="llm-chat-message assistant thinking"><span class="llm-avatar">T</span><div><p><span class="llm-thinking-dots"><b>.</b><b>.</b><b>.</b></span></p></div></div>`
    : "";

  const streamingHtml = llmStreaming
    ? `<div class="llm-chat-message assistant streaming"><span class="llm-avatar">T</span><div><p>${esc(llmStreaming.text.slice(0, llmStreaming.index))}<span class="streaming-caret">▋</span></p></div></div>`
    : "";

  const retryHtml = llmRetry
    ? `<div class="llm-retry-status"><span class="retry-spinner"></span>正在重新连接 ${llmRetry.attempt}/${llmRetry.max}</div>`
    : "";

  const modeMenuHtml = modeMenuOpen
    ? `<div class="llm-mode-menu">${["受限", "标准", "完全访问"].map((m) => `<button data-mode="${m}">${m}</button>`).join("")}</div>`
    : "";
  const sendLabel = llmStreaming ? "■" : "↑";

  return (
    <section className={`page llm-chat-page ${isTaskMode ? "task-chat-page" : ""}`}>
      <header className="llm-chat-header">
        <button className="llm-back" onClick={routeBack}>‹</button>
        <span>{isTaskMode ? "当前任务" : "模型对话"}</span>
        {isTaskMode ? <button className="kimi-action-button" onClick={stopProcessing}>停止任务</button> : null}
      </header>
      <div className="llm-chat-scroll">
        <div
          className="llm-chat-content"
          dangerouslySetInnerHTML={{ __html: `${executionHtml}${messages}${thinkingHtml}${retryHtml}${streamingHtml}` }}
        />
      </div>
      <button className="to-bottom-button" aria-label="回到底部" onClick={() => {
        const el = document.querySelector(".llm-chat-scroll");
        if (el) el.scrollTop = el.scrollHeight;
      }}>↓</button>
      <div className="llm-composer">
        <div className="llm-paths">
          {attachedPaths.map((p, i) => (
            <span key={i} className="llm-path-chip">
              <span>{p}</span>
              <button
                onClick={() => setAttachedPaths(attachedPaths.filter((_, idx) => idx !== i))}
                aria-label="删除路径">×</button>
            </span>
          ))}
        </div>
        <div
          ref={editorRef}
          className="llm-input"
          contentEditable
          role="textbox"
          aria-multiline="true"
          aria-disabled="false"
          aria-label="向 TriMusicAgent 发送你的想法"
          data-placeholder="向 TriMusicAgent 发送你的想法"
          onInput={handleInput}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (isTaskMode) {
                (state as any).startProcessing?.();
              } else if (llmStreaming) {
                // interrupt
              } else {
                sendPrompt();
              }
            }
          }}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          suppressContentEditableWarning
        />
        <div className="llm-composer-footer">
          <button className="llm-add-path" aria-label="添加路径" onClick={() => {
            setAttachedPaths([...attachedPaths, "D:\\TriMusicAgent\\Music"]);
            console.info("[LlmChat] add-path");
          }}>＋</button>
          <div className="llm-context-controls">
            <div className="llm-mode-wrap">
              <button className="llm-context-mode" onClick={() => setModeMenuOpen(!modeMenuOpen)}>{mode}模式⌄</button>
              {modeMenuOpen ? (
                <div className="llm-mode-menu">
                  {(["受限", "标准", "完全访问"] as const).map((m) => {
                    const map: Record<string, "restricted" | "standard" | "full"> = { "受限": "restricted", "标准": "standard", "完全访问": "full" };
                    return <button key={m} onClick={() => { selectMode(map[m]); setModeMenuOpen(false); }}>{m}</button>;
                  })}
                </div>
              ) : null}
            </div>
            <button className="llm-context-network" onClick={toggleNetwork}>{networkEnabled ? "联网检索模式" : "离线"}</button>
          </div>
          <span className="context-meter" style={{ "--usage": `${contextUsage}%` } as React.CSSProperties}><b>{contextUsage}%</b></span>
          <button
            className={`llm-send ${llmStreaming ? "is-interrupt" : ""}`}
            aria-label={llmStreaming ? "打断" : "发送"}
            onClick={() => {
              if (isTaskMode) {
                state.startProcessing?.();
              } else if (llmStreaming) {
                // interrupt - not implemented in prototype either
              } else {
                sendPrompt();
              }
            }}
          >{sendLabel}</button>
        </div>
      </div>
      {llmDebugText ? (
        <div style={{ margin: "8px auto 0", maxWidth: 720, padding: "8px 12px", color: "#9ff", fontSize: 11, fontFamily: "monospace", background: "#1a1a1a", border: "1px solid #333", borderRadius: 4, wordBreak: "break-all" }}>
          DEBUG: {llmDebugText}
        </div>
      ) : null}
      <small className="llm-disclaimer">内容由 AI 生成，请仔细甄别</small>
    </section>
  );
}
