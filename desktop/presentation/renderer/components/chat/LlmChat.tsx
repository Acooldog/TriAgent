import { useEffect, useRef, type CSSProperties } from "react";
import type { UseAppStateResult } from "../../hooks/useAppState/useAppState";
import { renderMarkdown } from "../../markdown";
import { ExecutionPanel } from "./ExecutionPanel";
import { BatchProgressCard } from "./BatchProgressCard";

export function LlmChat(state: UseAppStateResult) {
  const {
    llmMessages, llmStreaming, llmThinking, promptText, setPromptText,
    mode, networkEnabled, modeMenuOpen, setModeMenuOpen,
    conversationMode, setConversationMode, routeBack, executionCollapsed, setExecutionCollapsed,
    progress, toolEvents, contextUsage, toggleNetwork, selectMode,
    sendPrompt, attachedPaths, setAttachedPaths, llmRetry,
    stopProcessing, stopLlmStreaming, dashboardPromptRef, startProcessing, sendSupplement, answerAgentQuestion, processing,
    agentQuestion, batchProgress,
  } = state;

  const editorRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
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
      setConversationMode(true);
      requestAnimationFrame(() => {
        startProcessing();
      });
    }
  }, []);

  const isTaskMode = conversationMode;
  const hasInput = !!promptText.trim();

  const isInterrupt = isTaskMode ? (processing && !hasInput) : !!llmStreaming;
  const sendLabel = isInterrupt ? "■" : "↑";

  const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt", '"': "&quot;", "'": "&#39;" }[c]!));

  const messages = isTaskMode
    ? state.agentMessages
      .filter((message) => message.role !== "notice")
      .map((message) =>
        message.role === "user"
          ? `<div class="llm-chat-message user"><div class="llm-chat-md">${renderMarkdown(message.text)}</div><span class="llm-avatar user-avatar">你</span></div>`
          : message.role === "error"
            ? `<div class="llm-chat-message assistant"><span class="llm-avatar">T</span><div><p style="color:var(--系统错误色,#ff3b30)">${esc(message.text)}</p></div></div>`
            : `<div class="llm-chat-message assistant"><span class="llm-avatar">T</span><div class="llm-chat-md">${renderMarkdown(message.text)}</div></div>`
      ).join("")
    : llmMessages.map((message) => {
      if (message.role === "error") {
        return `<div class="llm-error-message"><div><strong>AI 连接错误</strong><p>${esc(message.text)}</p></div><button>重试</button></div>`;
      }
      if (message.role === "notice") {
        return `<div class="llm-system-notice"><span>${esc(message.text)}</span></div>`;
      }
      return message.role === "user"
        ? `<div class="llm-chat-message user"><div class="llm-chat-md">${renderMarkdown(message.text)}</div><span class="llm-avatar user-avatar">你</span></div>`
        : `<div class="llm-chat-message assistant"><span class="llm-avatar">T</span><div class="llm-chat-md">${renderMarkdown(message.text)}</div></div>`;
    }).join("");

  const thinkingHtml = llmThinking && !llmStreaming
    ? `<div class="llm-chat-message assistant thinking"><span class="llm-avatar">T</span><div><p><span class="llm-thinking-dots"><b>.</b><b>.</b><b>.</b></span></p></div></div>`
    : "";

  const streamingHtml = llmStreaming
    ? `<div class="llm-chat-message assistant streaming"><span class="llm-avatar">T</span><div><p>${esc(llmStreaming.text.slice(0, llmStreaming.index))}<span class="streaming-caret">▋</span></p></div></div>`
    : "";

  const retryHtml = llmRetry
    ? `<div class="llm-retry-status"><span class="retry-spinner"></span>正在重新连接 ${llmRetry.attempt}/${llmRetry.max}</div>`
    : "";

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    console.info("[LlmChat] auto-scroll to bottom", { scrollHeight: el.scrollHeight });
  }, [messages, llmStreaming, llmThinking, llmRetry]);

  const modeMenuHtml = modeMenuOpen
    ? `<div class="llm-mode-menu">${["受限", "标准", "完全访问"].map((m) => `<button data-mode="${m}">${m}</button>`).join("")}</div>`
    : "";

  return (
    <section className={`page llm-chat-page ${isTaskMode ? "task-chat-page" : ""}`}>
      <header className="llm-chat-header">
        <button className="llm-back" onClick={routeBack}>‹</button>
        <span>{isTaskMode ? "当前任务" : "模型对话"}</span>
        {isTaskMode ? <button className="kimi-action-button" onClick={stopProcessing}>停止任务</button> : null}
      </header>
      <div className="llm-chat-scroll" ref={scrollRef}>
        {isTaskMode ? (
          <div className="llm-chat-content">
            <ExecutionPanel
              collapsed={executionCollapsed}
              onToggle={() => setExecutionCollapsed(!executionCollapsed)}
              progress={progress}
              toolEvents={toolEvents}
            />
            <div
              className="llm-chat-messages"
              dangerouslySetInnerHTML={{ __html: `${messages}${thinkingHtml}${retryHtml}${streamingHtml}` }}
            />
            {batchProgress.active || batchProgress.finished ? (
              <BatchProgressCard progress={batchProgress} />
            ) : null}
          </div>
        ) : (
          <div
            className="llm-chat-content"
            dangerouslySetInnerHTML={{ __html: `${messages}${thinkingHtml}${retryHtml}${streamingHtml}` }}
          />
        )}
      </div>
      {agentQuestion ? (
        <div className="llm-question-overlay">
          <div className="llm-question-card">
            <div className="llm-question-title">Agent 需要你的确认</div>
            <p className="llm-question-text">{agentQuestion.question}</p>
            <div className="llm-question-options">
              {agentQuestion.options.map((opt) => (
                <button
                  key={opt}
                  className="llm-question-option"
                  onClick={() => answerAgentQuestion(opt)}
                >
                  {opt}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
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
              console.info("[LlmChat] enter-key:", { isTaskMode, processing, hasInput, llmStreaming });
              if (isTaskMode) {
                if (processing) {
                  if (hasInput) {
                    sendSupplement();
                  } else {
                    stopProcessing();
                  }
                } else {
                  startProcessing();
                }
              } else if (llmStreaming) {
                stopLlmStreaming();
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
          <span className="context-meter" style={{ "--usage": `${contextUsage}%` } as CSSProperties}><b>{contextUsage}%</b></span>
          <button
            className={`llm-send ${isInterrupt ? "is-interrupt" : ""}`}
            aria-label={isInterrupt ? "中断" : "发送"}
            onClick={() => {
              console.info("[LlmChat] send-click:", { isTaskMode, processing, hasInput, llmStreaming, isInterrupt });
              if (isTaskMode) {
                if (processing) {
                  if (hasInput) {
                    sendSupplement();
                  } else {
                    stopProcessing();
                  }
                } else {
                  startProcessing();
                }
              } else if (llmStreaming) {
                stopLlmStreaming();
              } else {
                sendPrompt();
              }
            }}
          >{sendLabel}</button>
        </div>
      </div>
      <small className="llm-disclaimer">内容由 AI 生成，请仔细甄别</small>
    </section>
  );
}
