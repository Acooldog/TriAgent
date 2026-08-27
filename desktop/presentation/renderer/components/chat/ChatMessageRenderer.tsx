/** ChatMessageRenderer — Renders individual chat messages with role-based styling. */
import type { AgentSegment, LlmMessage } from "../../hooks/useAppState/useAppState.types";
import { renderMarkdown } from "../../markdown";
import { AgentExecutionSegments } from "./AgentExecutionSegments";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt", '"': "&quot;", "'": "&#39;" }[c]!));
}

interface ChatMessageProps {
  message: LlmMessage;
  index: number;
  segsAbove?: AgentSegment[];
}

export function ChatMessageRenderer({ message, index, segsAbove }: ChatMessageProps) {
  const role = message.role;

  const msgEl = (() => {
    if (role === "user") {
      return (
        <div className="llm-chat-message user">
          <span className="llm-avatar">我</span>
          <div dangerouslySetInnerHTML={{ __html: renderMarkdown(message.text) }} />
        </div>
      );
    }
    if (role === "error") {
      return (
        <div className="llm-chat-message assistant">
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
        <div className="llm-system-notice">
          <span>{esc(message.text)}</span>
        </div>
      );
    }
    // assistant
    return (
      <div className="llm-chat-message assistant">
        <span className="llm-avatar">T</span>
        <div className="llm-chat-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(message.text) }} />
      </div>
    );
  })();

  if (segsAbove && segsAbove.length > 0) {
    return (
      <div>
        <AgentExecutionSegments segments={segsAbove} />
        {msgEl}
      </div>
    );
  }
  return <div>{msgEl}</div>;
}
