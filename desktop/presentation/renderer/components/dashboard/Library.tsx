import type { UseAppStateResult, HistoryItem } from "../../hooks/useAppState/useAppState";

export function Library(state: UseAppStateResult) {
  const { queue, libraryQuery, setLibraryQuery, libraryPlatform, setLibraryPlatform, libraryFormat, setLibraryFormat, showToast, routeBack } = state;
  const query = libraryQuery.toLowerCase();
  const rows = queue
    .filter((file) => (!query || `${file.title}${file.artist}`.toLowerCase().includes(query)) && (libraryPlatform === "全部" || file.platform === libraryPlatform) && (libraryFormat === "全部" || file.input === libraryFormat))
    .map((file) => (
      <tr key={file.id}>
        <td><span className={`cover ${file.cover}`}><i></i><i></i><i></i><i></i></span><span className="file-name"><b>{file.title}</b><small>{file.artist}</small></span></td>
        <td><span className={`badge badge-${file.platform.replace(/\s/g, "-")}`}>{file.platform}</span></td>
        <td><code>{file.input}</code></td>
        <td><code>{file.output}</code></td>
        <td><span className={`badge badge-${file.status.replace(/\s/g, "-")}`}>{file.status}</span></td>
        <td>{file.size}</td>
        <td><button className="link-button" onClick={() => showToast("已打开文件操作菜单")}>•••</button></td>
      </tr>
    ));

  return (
    <section className="page">
      <div className="page-heading">
        <button className="page-back" onClick={routeBack} aria-label="返回">‹</button>
        <div><h2>音乐库</h2><p>查看已识别的音乐文件与处理结果。</p></div>
        <button className="primary" onClick={() => showToast("已添加模拟音乐文件")}>＋ 添加音乐</button>
      </div>
      <div className="filter-bar">
        <input value={libraryQuery} onChange={(e) => setLibraryQuery(e.target.value)} placeholder="搜索文件名、艺术家或路径" />
        <select value={libraryPlatform} onChange={(e) => setLibraryPlatform(e.target.value)}>
          <option>全部</option><option>QQ 音乐</option><option>网易云音乐</option><option>本地文件</option>
        </select>
        <select value={libraryFormat} onChange={(e) => setLibraryFormat(e.target.value)}>
          <option>全部</option><option>ncm</option><option>mgg</option><option>qmc3</option><option>kgm</option>
        </select>
      </div>
      <div className="library-card">
        <table>
          <thead>
            <tr><th>音乐文件</th><th>平台</th><th>输入格式</th><th>输出格式</th><th>状态</th><th>大小</th><th>操作</th></tr>
          </thead>
          <tbody>{rows.length ? rows : <tr><td colSpan={7} className="empty">没有匹配的音乐文件</td></tr>}</tbody>
        </table>
      </div>
    </section>
  );
}

export function History(state: UseAppStateResult) {
  const { history, showToast, routeBack, setAgentMessages, setConversationMode, navigateTo } = state;

  const viewHistoryItem = (item: HistoryItem) => {
    console.info("[History] viewing history item:", item.id);
    setConversationMode(true);
    if (item.messages && item.messages.length > 0) {
      // 加载历史会话的完整消息
      setAgentMessages(item.messages);
    } else {
      // 没有存储消息，显示恢复提示
      setAgentMessages([{ role: "notice" as const, text: `正在恢复历史会话：${item.title}` }]);
    }
    // 如果任务仍在进行中，确保 processing 状态正确
    if (item.status === "处理中") {
      // 任务在后台继续运行，UI 会通过 worker 事件接收更新
      showToast(`任务仍在后台运行中，正在恢复会话：${item.title.slice(0, 20)}`);
    } else {
      showToast(`已恢复会话：${item.title.slice(0, 20)}`);
    }
    navigateTo("llm");
  };

  return (
    <section className="page">
      <div className="page-heading">
        <button className="page-back" onClick={routeBack} aria-label="返回">‹</button>
        <div><h2>任务历史</h2><p>每个 TriMusicAgent 任务都可以恢复、重试和查看诊断信息。</p></div>
        <button className="secondary" onClick={() => showToast("已导出任务摘要")}>导出任务摘要</button>
      </div>
      <div className="history-tabs">
        <button className="active">全部</button><button>成功</button><button>失败</button><button>处理中</button><button>已停止</button>
        <input placeholder="搜索任务名称" />
      </div>
      <div className="history-list">
        {history.length === 0 ? (
          <div className="empty-state" style={{ padding: "40px", textAlign: "center", color: "var(--km-label-tertiary)" }}>
            暂无历史任务。完成任务后会自动记录在此。
          </div>
        ) : history.map((item) => (
          <article key={item.id} className="history-row">
            <div className="history-main"><b>{item.title}</b><small>{item.date} · {item.total} 个文件 · 总耗时 {item.time}</small></div>
            <div className="history-numbers"><span className="good">{item.success} 成功</span><span className="bad">{item.failed} 失败</span></div>
            <span className={`badge badge-${item.status.replace(/\s/g, "-")}`}>{item.status}</span>
            <div className="row-actions">
              <button onClick={() => viewHistoryItem(item)}>查看</button>
              <button onClick={() => showToast("已重试任务")}>重试</button>
              <button onClick={() => showToast("已打开输出目录")}>打开目录</button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
