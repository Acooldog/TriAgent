import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import type { UseAppStateResult } from "../../hooks/useAppState/useAppState";
import type { AgentSegment, LlmMessage } from "../../hooks/useAppState/useAppState.types";
import { renderMarkdown } from "../../markdown";
import { BatchProgressCard } from "./BatchProgressCard";
import { AgentExecutionSegments } from "./AgentExecutionSegments";

export function LlmChat(state: UseAppStateResult) {
  const {
    llmMessages, llmStreaming, llmThinking, promptText, setPromptText,
    mode, networkEnabled, modeMenuOpen, setModeMenuOpen,
    conversationMode, setConversationMode, routeBack,
    contextUsage, toggleNetwork, selectMode,
    sendPrompt, attachedPaths, setAttachedPaths, llmRetry,
    stopProcessing, stopLlmStreaming, dashboardPromptRef, startProcessing, sendSupplement, answerAgentQuestion, processing,
    agentQuestion, batchProgress, agentSegments, agentMessages,
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

  // 构建 timeline: messages + segments 按时间排序后渲染
  // 每条 message 上方显示: 上一条 message 之后、当前 message 之前产生的 segments
  const messageList = isTaskMode
    ? agentMessages.filter((m) => m.role !== "notice")
    : llmMessages;

  const segmentsByMessage = useMemo(() => {
    if (!isTaskMode) return new Map<number, AgentSegment[]>();
    const map = new Map<number, AgentSegment[]>();
    for (let i = 0; i < messageList.length; i++) {
      const msg = messageList[i];
      const msgTime = msg.createdAt ?? 0;
      const prevTime = i > 0 ? (messageList[i - 1].createdAt ?? 0) : 0;
      const relevant = agentSegments.filter(
        (seg) => seg.createdAt >= prevTime && seg.createdAt <= msgTime
      );
      if (relevant.length > 0) map.set(i, relevant);
    }
    return map;
  }, [isTaskMode, messageList, agentSegments]);

  const esc = (s: string): string =>
    s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt", '"': "&quot;", "'": "&#39;" }[c]!));

  const renderMessage = (message: LlmMessage, idx: number) => {
    const segsAbove = isTaskMode ? segmentsByMessage.get(idx) : undefined;
    const role = message.role;

    // Build the message element — avatar must be INSIDE .llm-chat-message
    // because the CSS uses grid-template-columns: 32px 1fr on it
    const msgEl = (() => {
      if (role === "user") {
        return (
          <div key={idx} className="llm-chat-message user">
            <span className="llm-avatar">我</span>
            <div dangerouslySetInnerHTML={{ __html: renderMarkdown(message.text) }} />
          </div>
        );
      }
      if (role === "error") {
        return (
          <div key={idx} className="llm-chat-message assistant">
            <span className="llm-avatar">T</span>
            <div>
              <strong style={{ color: "var(--系统错误色,#ff3b30)" }}>错误</strong>
              <p style={{ color: "var(--系统错误色,#ff3b30)" }}>{esc(message.text)}</p>
            </div>
          </div>
        );
      }
      if (role === "notice") {
        return (
          <div key={idx} className="llm-system-notice">
            <span>{esc(message.text)}</span>
          </div>
        );
      }
      // assistant
      return (
        <div key={idx} className="llm-chat-message assistant">
          <span className="llm-avatar">T</span>
          <div dangerouslySetInnerHTML={{ __html: renderMarkdown(message.text) }} />
        </div>
      );
    })();

    if (segsAbove && segsAbove.length > 0) {
      return (
        <div key={`segs+msg-${idx}`}>
          <AgentExecutionSegments segments={segsAbove} />
          {msgEl}
        </div>
      );
    }
    return <div key={idx}>{msgEl}</div>;
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    console.info("[LlmChat] auto-scroll to bottom", { scrollHeight: el.scrollHeight });
  }, [messageList, llmStreaming, llmThinking, llmRetry, agentSegments]);

  const modeMenuHtml = modeMenuOpen
    ? (
      <div className="llm-mode-menu">
        {(["受限", "标准", "完全访问"] as const).map((m) => {
          const map: Record<string, "restricted" | "standard" | "full"> = { "受限": "restricted", "标准": "standard", "完全访问": "full" };
          return <button key={m} onClick={() => { selectMode(map[m]); setModeMenuOpen(false); }}>{m}</button>;
        })}
      </div>
    )
    : null;

  return (
    <section className={`page llm-chat-page ${isTaskMode ? "task-chat-page" : ""}`}>
      <header className="llm-chat-header">
        <button className="llm-back" onClick={routeBack}>‹</button>
        <span>{isTaskMode ? "当前任务" : "模型对话"}</span>
      </header>
      <div className="llm-chat-scroll" ref={scrollRef}>
        <div className="llm-chat-content">
          {messageList.map((msg, idx) => renderMessage(msg, idx))}
          {isTaskMode && (
            <>
              {agentSegments.length > 0 && messageList.length > 0 && (() => {
                // 末尾 segments：最后一条消息之后产生的 segments
                const lastMsgTime = messageList[messageList.length - 1]?.createdAt ?? 0;
                const tailSegs = agentSegments.filter((s) => s.createdAt >= lastMsgTime);
                return tailSegs.length > 0 ? <AgentExecutionSegments segments={tailSegs} /> : null;
              })()}
              {batchProgress.active || batchProgress.finished ? (
                <BatchProgressCard progress={batchProgress} />
              ) : null}
            </>
          )}
          {/* thinking / streaming / retry (non-task mode 也需要) */}
          {!isTaskMode && llmThinking && !llmStreaming && (
            <div className="llm-chat-message assistant thinking">
              <span className="llm-avatar">T</span>
              <div>
                <p><span className="llm-thinking-dots"><b>.</b><b>.</b><b>.</b></span></p>
              </div>
            </div>
          )}
          {llmStreaming && (
            <div className="llm-chat-message assistant streaming">
              <span className="llm-avatar">T</span>
              <div>
                <p>{esc(llmStreaming.text.slice(0, llmStreaming.index))}<span className="streaming-caret">▋</span></p>
              </div>
            </div>
          )}
          {llmRetry && (
            <div className="llm-retry-status">
              <span className="retry-spinner"></span>正在重新连接 {llmRetry.attempt}/{llmRetry.max}
            </div>
          )}
        </div>
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
              {modeMenuHtml}
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
