import { useEffect, useRef, useState } from "react";
import type { UseAppStateResult } from "../hooks/useAppState";

const HEADLINE_PHRASES = ["我能为你做什么", "想解密音乐吗？", "bilibili关注牢大了吗"];
const SUGGESTIONS = [
  "把这批文件转成 FLAC",
  "识别这个文件夹里的音乐格式",
  "检查 QQ 音乐解密环境",
  "保留原始文件并输出到新目录",
];

export function Dashboard(state: UseAppStateResult) {
  const { queue, history, progress, processing, mode, promptText, setPromptText, navigateTo, setConversationMode, startProcessing, sendPrompt, submitFromDashboard, setAttachedPaths, attachedPaths, showToast, autoCompression, setAutoCompression, compressionThreshold, setCompressionThreshold } = state;

  const [typewriterText, setTypewriterText] = useState("");
  const [phraseIdx, setPhraseIdx] = useState(0);
  const [charIdx, setCharIdx] = useState(0);
  const [deleting, setDeleting] = useState(false);

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
    const current = HEADLINE_PHRASES[phraseIdx];
    if (!deleting && charIdx < current.length) {
      const t = setTimeout(() => { setTypewriterText(current.slice(0, charIdx + 1)); setCharIdx(charIdx + 1); }, 120);
      return () => clearTimeout(t);
    } else if (!deleting && charIdx >= current.length) {
      const t = setTimeout(() => setDeleting(true), 2000);
      return () => clearTimeout(t);
    } else if (deleting && charIdx > 0) {
      const t = setTimeout(() => { setTypewriterText(current.slice(0, charIdx - 1)); setCharIdx(charIdx - 1); }, 60);
      return () => clearTimeout(t);
    } else {
      setDeleting(false);
      setPhraseIdx((phraseIdx + 1) % HEADLINE_PHRASES.length);
      setCharIdx(0);
    }
  }, [charIdx, deleting, phraseIdx]);

  const activeTask = processing ? (
    <button className="active-task-card" onClick={() => { setConversationMode(true); navigateTo("llm"); }}>
      <span className="active-progress"><b>{progress}%</b></span>
      <span className="active-task-copy"><small>进行中的任务</small><strong>正在处理音乐文件</strong><em>TriMusicAgent 正在执行工具调用</em></span>
      <span className="active-task-arrow">继续</span>
    </button>
  ) : null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submitFromDashboard(promptText);
    }
  };

  const applySuggestion = (text: string) => {
    if (isComposingRef.current) isComposingRef.current = false;
    submitFromDashboard(text);
  };

  return (
    <section className="page writer-dashboard compose-mode">
      <div className="writer-top">
        <div className="writer-title">
          <h2>TriMusicAgent</h2>
          <p><span className="subtitle-typewriter">{typewriterText}</span></p>
        </div>
        <div className="writer-account">
          <button className="btn" onClick={() => showToast("暂无新消息")}>消息</button>
          <button className="btn account-button" onClick={() => navigateTo("settings")}>{mode}模式</button>
        </div>
      </div>
      <div className="writer-columns">
        <main>
          <article className="prompt-card">
            <div className="prompt-editor">
              {attachedPaths.length > 0 && (
                <div className="prompt-path-row">
                  {attachedPaths.map((p, i) => (
                    <span key={i} className="path-chip"><span>{p}</span><button
                      onClick={() => setAttachedPaths(attachedPaths.filter((_, idx) => idx !== i))}
                      aria-label="删除路径">×</button></span>
                  ))}
                </div>
              )}
              <div
                ref={editorRef}
                className="prompt-text-input"
                contentEditable
                role="textbox"
                aria-multiline="true"
                aria-label="告诉 TriMusicAgent 你想怎么处理音乐，例如：扫描 QQ 音乐文件并转成 MP3"
                data-placeholder="告诉 TriMusicAgent 你想怎么处理音乐，例如：扫描 QQ 音乐文件并转成 MP3"
                onInput={handleInput}
                onKeyDown={handleKeyDown}
                onCompositionStart={handleCompositionStart}
                onCompositionEnd={handleCompositionEnd}
                suppressContentEditableWarning
              />
              <div className="prompt-footer">
                <span className="prompt-count">{promptText.length} / 500</span>
                <button className="btn primary" onClick={() => submitFromDashboard(promptText)}>发送</button>
              </div>
            </div>
          </article>
          {activeTask}
          <div className="suggestion-row">
            {SUGGESTIONS.map((item) => (
              <button key={item} className="btn" onClick={() => { applySuggestion(item); console.info("[Dashboard] use-suggestion:", item); }}>{item}</button>
            ))}
            <button className="btn suggestion-refresh" onClick={() => showToast("已刷新建议")}>刷新建议</button>
          </div>
          <div className="writer-stats">
            <article className="writer-stat"><span>处理情况</span><strong>{queue.length}</strong><small>待处理文件</small><div className="stat-meta"><b>{queue.length > 0 ? '处理中' : '暂无'}</b><small>当前状态</small></div></article>
            <article className="writer-stat"><span>本地任务</span><strong>{history.length}</strong><small>已完成任务</small><div className="stat-meta"><b>{history.length > 0 ? history.length : '暂无'}</b><small>累计 TriMusicAgent 任务</small></div></article>
            <article className="writer-stat"><span>权限模式</span><strong>{mode}</strong><small>当前运行模式</small><div className="stat-meta"><b>{progress}%</b><small>当前进度</small></div></article>
          </div>
          <div className="tool-section">
            <div className="section-head"><h3>常用入口</h3><button className="btn plain-action" onClick={() => navigateTo("history")}>查看任务历史</button></div>
            <div className="tool-grid">
              <button className="btn tool-card" onClick={() => navigateTo("task")}><span className="tool-index">01</span><b>批量处理</b><small>查看 TriMusicAgent 执行过程</small><i>打开</i></button>
              <button className="btn tool-card" onClick={() => navigateTo("library")}><span className="tool-index">02</span><b>音乐库</b><small>浏览已识别的音乐结果</small><i>打开</i></button>
              <button className="btn tool-card" onClick={() => navigateTo("diagnostics")}><span className="tool-index">03</span><b>运行诊断</b><small>确认运行环境是否正常</small><i>检查</i></button>
              <button className="btn tool-card" onClick={() => { setConversationMode(false); navigateTo("llm"); }}><span className="tool-index">04</span><b>模型服务</b><small>配置模型对话服务</small><i>配置</i></button>
            </div>
          </div>
        </main>
        <aside className="writer-aside">
          <article className="aside-card aside-welcome">
            <h3>你的音乐，留在你的电脑里</h3>
            <p>文件、会话和任务状态都保存在你选择的工作数据根目录。</p>
            <ul>
              <li>不上传本地音频</li>
              <li>敏感操作先征得同意</li>
              <li>错误会给出下一步建议</li>
            </ul>
            <button className="btn aside-primary" onClick={() => navigateTo("settings")}>查看工作目录</button>
          </article>
          <article className="aside-card aside-recent">
            <div className="section-head"><h3>最近任务</h3><button className="btn plain-action" onClick={() => navigateTo("history")}>全部</button></div>
            {history.length === 0 ? (
              <p className="aside-empty">暂无历史任务，开始你的第一个任务吧</p>
            ) : (
              history.slice(0, 3).map((item) => (
                <button key={item.id} className="btn aside-task" onClick={() => navigateTo("history")}>
                  <span className="task-mark">{item.status === "成功" ? "OK" : "error"}</span>
                  <span><b>{item.title}</b><small>{item.date}</small></span>
                </button>
              ))
            )}
          </article>
        </aside>
      </div>
    </section>
  );
}
