import type { UseAppStateResult } from "../hooks/useAppState";

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
  const { history, showToast, routeBack } = state;
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
        {history.map((item) => (
          <article key={item.id} className="history-row">
            <div className="history-main"><b>{item.title}</b><small>{item.date} · {item.total} 个文件 · 总耗时 {item.time}</small></div>
            <div className="history-numbers"><span className="good">{item.success} 成功</span><span className="bad">{item.failed} 失败</span></div>
            <span className={`badge badge-${item.status.replace(/\s/g, "-")}`}>{item.status}</span>
            <div className="row-actions">
              <button onClick={() => showToast("已打开任务详情")}>查看</button>
              <button onClick={() => showToast("已重试任务")}>重试</button>
              <button onClick={() => showToast("已打开输出目录")}>打开目录</button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
