import { useEffect, useRef, useState } from "react";
import type { UseAppStateResult } from "../hooks/useAppState";
import type { ToolEvent, AgentLogEntry } from "../hooks/useAppState";

const TOOL_ICON_MAP: Record<string, string> = {
  decrypt_kugou: "🔓",
  scan_files: "🔍",
  move_files: "📦",
  detect_format: "🎵",
  list_directory: "📁",
};

const LOG_LEVEL_COLORS: Record<string, string> = {
  info: "#007aff",
  warn: "#ff9500",
  error: "#ff3b30",
  debug: "#8e8e93",
};

function AgentLogPanel({
  logs,
  visible,
  onToggle,
}: {
  logs: AgentLogEntry[];
  visible: boolean;
  onToggle: () => void;
}) {
  if (!visible) {
    return (
      <div className="llm-agent-log-toggle" onClick={onToggle}>
        📋 Agent 日志 ({logs.length})
      </div>
    );
  }

  return (
    <div className="llm-agent-log-panel">
      <div className="llm-agent-log-head">
        <span>📋 Agent 日志 ({logs.length})</span>
        <button onClick={onToggle}>隐藏</button>
      </div>
      <div className="llm-agent-log-body">
        {logs.length === 0 ? (
          <div className="llm-agent-log-empty">等待日志输出...</div>
        ) : (
          logs.map((log, i) => (
            <div key={i} className={`llm-agent-log-line level-${log.level}`}>
              <span className="llm-agent-log-level" style={{ color: LOG_LEVEL_COLORS[log.level] }}>
                [{log.level.toUpperCase()}]
              </span>
              <span className="llm-agent-log-msg">{log.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ExecutionPanel({
  collapsed,
  onToggle,
  progress,
  toolEvents,
  logs,
  showLogs,
  onToggleLogs,
}: {
  collapsed: boolean;
  onToggle: () => void;
  progress: number;
  toolEvents: ToolEvent[];
  logs: AgentLogEntry[];
  showLogs: boolean;
  onToggleLogs: () => void;
}) {
  const events = toolEvents.map((event, i) => {
    const icon = TOOL_ICON_MAP[event.name] ?? "⚙️";
    const statusLabel =
      event.status === "done" ? "完成" :
        event.status === "running" ? "执行中" :
          event.status === "error" ? "失败" : "等待";
    const elapsed = event.elapsedSec ? ` (${event.elapsedSec.toFixed(1)}s)` : "";
    const resultPreview = event.toolResult
      ? event.toolResult.slice(0, 80) + (event.toolResult.length > 80 ? "..." : "")
      : "";
    return (
      <div key={`${event.name}-${i}`} className="agent-tool-call">
        <div className={`agent-tool-call-icon ${event.name}`}>{icon}</div>
        <div className="agent-tool-call-info">
          <span className="agent-tool-call-name">{event.name}</span>
          {resultPreview ? (
            <small className="agent-tool-call-detail">{resultPreview}</small>
          ) : null}
        </div>
        <span className={`agent-tool-call-status ${event.status}`}>
          {statusLabel}{elapsed}
        </span>
      </div>
    );
  });

  return (
    <div className={`llm-execution-sticky ${collapsed ? "is-collapsed" : ""}`}>
      <div className="llm-execution-head">
        <strong>Agent 执行过程</strong>
        <span>{progress}%</span>
        <button onClick={onToggle}>{collapsed ? "展开" : "收起"}</button>
      </div>
      <div className="execution-bar"><i style={{ width: `${progress}%` }} /></div>
      {events.length > 0 ? (
        <div className="llm-execution-events">{events}</div>
      ) : null}
      <AgentLogPanel logs={logs} visible={showLogs} onToggle={onToggleLogs} />
    </div>
  );
}

export function LlmChat(state: UseAppStateResult) {
  const {
    llmMessages, llmStreaming, llmThinking, promptText, setPromptText,
    mode, networkEnabled, modeMenuOpen, setModeMenuOpen,
    conversationMode, setConversationMode, routeBack, executionCollapsed, setExecutionCollapsed,
    progress, toolEvents, agentLogs, contextUsage, toggleNetwork, selectMode,
    sendPrompt, attachedPaths, setAttachedPaths, llmRetry,
    stopProcessing, dashboardPromptRef, startProcessing,
  } = state;

  const [showAgentLogs, setShowAgentLogs] = useState(true);

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
      setConversationMode(true);
      requestAnimationFrame(() => {
        startProcessing();
      });
    }
  }, []);

  const isTaskMode = conversationMode;

  const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt", '"': "&quot;", "'": "&#39;" }[c]!));

  const messages = isTaskMode
    ? state.agentMessages.map((message) =>
      message.role === "user"
        ? `<div class="llm-chat-message user"><p>${esc(message.text)}</p><span class="llm-avatar user-avatar">你</span></div>`
        : message.role === "error"
          ? `<div class="llm-chat-message assistant"><span class="llm-avatar">T</span><div><p style="color:var(--系统错误色,#ff3b30)">${esc(message.text)}</p></div></div>`
          : `<div class="llm-chat-message assistant"><span class="llm-avatar">T</span><div><p>${esc(message.text)}</p></div></div>`
    ).join("")
    : llmMessages.map((message) => {
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
        {isTaskMode ? (
          <div className="llm-chat-content">
            <ExecutionPanel
              collapsed={executionCollapsed}
              onToggle={() => setExecutionCollapsed(!executionCollapsed)}
              progress={progress}
              toolEvents={toolEvents}
              logs={agentLogs}
              showLogs={showAgentLogs}
              onToggleLogs={() => setShowAgentLogs(!showAgentLogs)}
            />
            <div
              className="llm-chat-messages"
              dangerouslySetInnerHTML={{ __html: `${messages}${thinkingHtml}${retryHtml}${streamingHtml}` }}
            />
          </div>
        ) : (
          <div
            className="llm-chat-content"
            dangerouslySetInnerHTML={{ __html: `${messages}${thinkingHtml}${retryHtml}${streamingHtml}` }}
          />
        )}
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
                startProcessing();
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
                startProcessing();
              } else if (llmStreaming) {
                // interrupt - not implemented in prototype either
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
