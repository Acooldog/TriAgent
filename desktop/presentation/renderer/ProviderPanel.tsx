import { useEffect, useRef, useState, type ReactElement } from "react";
import type { ProviderEvent, ProviderRegistration } from "../../application/providerProtocol";
import type { ProviderRuntimeEvent, ProviderRuntimeState } from "../../application/providerRuntimeProtocol";
import type { PermissionMode } from "../../application/toolProtocol";

export function ProviderPanel(): ReactElement {
  const [providers, setProviders] = useState<ProviderRegistration[]>([]);
  const [events, setEvents] = useState<ProviderEvent[]>([]);
  const [runtimeStates, setRuntimeStates] = useState<ProviderRuntimeState[]>([]);
  const [runtimeEvents, setRuntimeEvents] = useState<ProviderRuntimeEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [runtimeMessage, setRuntimeMessage] = useState("");
  const [providerId, setProviderId] = useState("");
  const [capabilityId, setCapabilityId] = useState("");
  const [inputText, setInputText] = useState("{}");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("standard");
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [resultText, setResultText] = useState("");
  const activeTaskRef = useRef<string | null>(null);
  const terminalTasks = useRef(new Set<string>());
  const invocationPending = useRef(false);

  useEffect(() => {
    let active = true;
    const unsubscribe = window.triMusicAgent.onProviderEvent((event) => {
      if (!active) return;
      setEvents((current) => [...current.slice(-29), event]);
      if (event.event_type === "provider_result") setResultText(formatPayload(event.payload));
      if (event.status === "completed" || event.status === "failed" || event.status === "cancelled") {
        if (activeTaskRef.current === event.task_id) setActiveTask(null);
        else if (invocationPending.current) terminalTasks.current.add(event.task_id);
        setMessage(event.status === "completed" ? "Provider 调用已完成。" : event.status === "cancelled" ? "Provider 调用已取消。" : event.error?.message || "Provider 调用失败。");
      }
    });
    const unsubscribeRuntime = window.triMusicAgent.onProviderRuntimeEvent((event) => {
      if (!active) return;
      setRuntimeEvents((current) => [...current.slice(-29), event]);
      if (event.providerId) void window.triMusicAgent.listProviderRuntimes().then((items) => { if (active) setRuntimeStates(items); });
    });
    void Promise.all([window.triMusicAgent.listProviders(), window.triMusicAgent.listProviderRuntimes()]).then(([items, runtimes]) => { if (active) { applyProviders(items); setRuntimeStates(runtimes); } });
    return () => { active = false; unsubscribe(); unsubscribeRuntime(); };
  }, []);

  useEffect(() => {
    const registration = providers.find((item) => item.manifest.provider_id === providerId);
    if (!registration?.manifest.capabilities.some((item) => item.capability_id === capabilityId)) {
      setCapabilityId(registration?.manifest.capabilities[0]?.capability_id ?? "");
    }
  }, [providers, providerId, capabilityId]);

  const setActiveTask = (taskId: string | null) => {
    activeTaskRef.current = taskId;
    setActiveTaskId(taskId);
  };

  const applyProviders = (items: ProviderRegistration[]) => {
    setProviders(items);
    setProviderId((current) => items.some((item) => item.manifest.provider_id === current) ? current : items[0]?.manifest.provider_id ?? "");
  };

  const refresh = async () => {
    setBusy(true);
    setMessage("");
    try {
      const [items, runtimes] = await Promise.all([window.triMusicAgent.refreshProviders(), window.triMusicAgent.discoverProviderRuntimes()]);
      applyProviders(items);
      setRuntimeStates(runtimes);
      setMessage(items.length || runtimes.some((item) => item.providerId) ? "Provider 清单和运行时状态已刷新。" : "未配置 Provider。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Provider 刷新失败。"); }
    finally { setBusy(false); }
  };

  const toggle = async (registration: ProviderRegistration) => {
    try {
      const updated = await window.triMusicAgent.setProviderEnabled(registration.manifest.provider_id, !registration.enabled);
      setProviders((current) => current.map((item) => item.manifest.provider_id === updated.manifest.provider_id ? updated : item));
    } catch (error) { setMessage(error instanceof Error ? error.message : "Provider 设置失败。"); }
  };

  const checkHealth = async (id: string) => {
    try {
      const updated = await window.triMusicAgent.checkProviderHealth(id);
      setProviders((current) => current.map((item) => item.manifest.provider_id === id ? updated : item));
    } catch (error) { setMessage(error instanceof Error ? error.message : "Provider 健康检查失败。"); }
  };

  const invoke = async () => {
    setMessage("");
    setResultText("");
    if (!providerId || !capabilityId) return setMessage("请先选择 Provider 和能力。");
    let input: unknown;
    try { input = JSON.parse(inputText) as unknown; } catch { return setMessage("调用参数必须是有效 JSON。"); }
    setBusy(true);
    invocationPending.current = true;
    try {
      const handle = await window.triMusicAgent.invokeProvider({ providerId, capabilityId, input, permissionMode });
      if (terminalTasks.current.has(handle.taskId)) terminalTasks.current.delete(handle.taskId);
      else { setActiveTask(handle.taskId); setMessage("Provider 调用已启动。"); }
    } catch (error) { setMessage(error instanceof Error ? error.message : "Provider 调用失败。"); }
    finally { invocationPending.current = false; setBusy(false); }
  };

  const cancel = async () => {
    if (!activeTaskId) return;
    try {
      const cancelled = await window.triMusicAgent.cancelProvider(activeTaskId);
      setMessage(cancelled ? "已请求取消 Provider 调用。" : "Provider 调用已结束，无法取消。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "取消 Provider 调用失败。"); }
  };

  const refreshRuntime = async (providerId: string) => {
    try {
      const state = await window.triMusicAgent.checkProviderRuntimeHealth(providerId);
      setRuntimeStates((current) => current.map((item) => item.providerId === providerId ? state : item));
      setRuntimeMessage(state.message || "运行时健康检查已完成。");
    } catch (error) { setRuntimeMessage(error instanceof Error ? error.message : "运行时健康检查失败。"); }
  };

  const startRuntime = async (providerId: string) => {
    setRuntimeMessage("");
    try {
      const state = await window.triMusicAgent.startProviderRuntime({ providerId, permissionMode });
      setRuntimeStates((current) => current.map((item) => item.providerId === providerId ? state : item));
      setRuntimeMessage(state.message || "Provider 运行时已启动。");
    } catch (error) { setRuntimeMessage(error instanceof Error ? error.message : "Provider 启动失败。"); }
  };

  const stopRuntime = async (providerId: string) => {
    try {
      const state = await window.triMusicAgent.stopProviderRuntime(providerId);
      setRuntimeStates((current) => current.map((item) => item.providerId === providerId ? state : item));
      setRuntimeMessage(state.message || "Provider 运行时已停止。");
    } catch (error) { setRuntimeMessage(error instanceof Error ? error.message : "Provider 停止失败。"); }
  };

  const selected = providers.find((item) => item.manifest.provider_id === providerId);
  return <section className="sessions-panel provider-panel">
    <div className="panel-heading">
      <div><h2>外部能力 Provider</h2><p>仅显示已通过合同校验的能力和脱敏事件。</p></div>
      <button type="button" onClick={() => void refresh()} disabled={busy}>刷新清单</button>
    </div>
    {message ? <p className="message provider-message">{message}</p> : null}
    <div className="provider-runtime">
      <div className="panel-heading"><div><h3>运行时管理</h3><p>启动、健康检查和停止只通过通用运行时协议执行。</p></div></div>
      {runtimeMessage ? <p className="message provider-message">{runtimeMessage}</p> : null}
      {runtimeStates.length === 0 || (runtimeStates.length === 1 && runtimeStates[0].providerId === null) ? <div className="empty-state">未配置 Provider。请配置后刷新。</div> : <div className="provider-list">{runtimeStates.filter((state) => state.providerId).map((state) => <article className="provider-row" key={state.providerId}>
        <div className="provider-summary"><div><strong>{state.displayName}</strong><small>{state.providerId}</small></div><span className={`health health-${state.status}`}>{runtimeStatusLabel(state.status)}</span></div>
        {state.message ? <p className="provider-health-message">{state.message}</p> : null}
        {state.recoverySuggestion ? <p className="provider-health-message">建议：{state.recoverySuggestion}</p> : null}
        <div className="worker-actions"><button type="button" onClick={() => void startRuntime(state.providerId!)} disabled={state.status === "starting" || state.status === "healthy"}>启动</button><button type="button" onClick={() => void refreshRuntime(state.providerId!)} disabled={state.status === "starting" || state.status === "stopping"}>检查健康</button><button type="button" onClick={() => void stopRuntime(state.providerId!)} disabled={state.status === "stopped" || state.status === "stopping"}>停止</button></div>
      </article>)}</div>}
      {runtimeEvents.length ? <div className="provider-events"><h3>运行时事件</h3>{runtimeEvents.slice().reverse().map((event) => <details className="timeline-entry" key={`${event.operationId}-${event.sequence}`}><summary><strong>{event.eventType}</strong><span>{runtimeStatusLabel(event.status)}</span><small>{formatDate(event.emittedAt)}</small></summary><pre>{formatPayload(event.payload)}</pre></details>)}</div> : null}
    </div>
    {providers.length === 0 ? <div className="empty-state">暂无已注册的 Provider。</div> : <div className="provider-list">{providers.map((registration) => <article className="provider-row" key={registration.manifest.provider_id}>
      <div className="provider-summary"><div><strong>{registration.manifest.name}</strong><small>{registration.manifest.provider_id} · 版本 {registration.manifest.version}</small></div><span className={`health health-${registration.health.status}`}>{healthLabel(registration.health.status)}</span></div>
      <p>{registration.manifest.capabilities.map((capability) => capability.name).join("、")}</p>
      {registration.health.message ? <p className="provider-health-message">{registration.health.message}</p> : null}
      <div className="worker-actions"><button type="button" onClick={() => void checkHealth(registration.manifest.provider_id)}>检查状态</button><button type="button" onClick={() => void toggle(registration)}>{registration.enabled ? "禁用" : "启用"}</button></div>
    </article>)}</div>}

    <div className="provider-invoke">
      <h3>调用 Provider</h3>
      <div className="provider-fields">
        <label>Provider<select value={providerId} onChange={(event) => setProviderId(event.target.value)} disabled={!providers.length}>{providers.map((item) => <option key={item.manifest.provider_id} value={item.manifest.provider_id}>{item.manifest.name}</option>)}</select></label>
        <label>能力<select value={capabilityId} onChange={(event) => setCapabilityId(event.target.value)} disabled={!selected}>{selected?.manifest.capabilities.map((item) => <option key={item.capability_id} value={item.capability_id}>{item.name}</option>)}</select></label>
        <label>权限模式<select value={permissionMode} onChange={(event) => setPermissionMode(event.target.value as PermissionMode)}><option value="restricted">受限</option><option value="standard">标准</option><option value="full">完全访问</option></select></label>
      </div>
      <label className="provider-input">JSON 参数<textarea value={inputText} onChange={(event) => setInputText(event.target.value)} spellCheck={false} /></label>
      <div className="worker-actions"><button type="button" onClick={() => void invoke()} disabled={busy || !selected || activeTaskId !== null}>开始调用</button><button type="button" onClick={() => void cancel()} disabled={!activeTaskId}>取消调用</button></div>
      {resultText ? <pre className="provider-result">{resultText}</pre> : null}
    </div>

    <div className="provider-events"><h3>Provider 事件</h3>{events.length === 0 ? <div className="empty-state">暂无 Provider 事件。</div> : events.slice().reverse().map((event) => <details className="timeline-entry" key={`${event.request_id}-${event.sequence}`}><summary><strong>{event.event_type}</strong><span>{eventStatusLabel(event.status)}</span><small>{formatDate(event.emitted_at)}</small></summary><pre>{formatPayload(event.payload)}</pre></details>)}</div>
  </section>;
}

function healthLabel(status: ProviderRegistration["health"]["status"]): string {
  if (status === "healthy") return "健康";
  if (status === "unhealthy") return "不可用";
  return "未检查";
}

function eventStatusLabel(status: ProviderEvent["status"]): string {
  if (status === "running") return "运行中";
  if (status === "completed") return "已完成";
  if (status === "cancelled") return "已取消";
  return "失败";
}

function runtimeStatusLabel(status: ProviderRuntimeState["status"]): string {
  if (status === "unconfigured") return "未配置";
  if (status === "stopped") return "已停止";
  if (status === "starting") return "启动中";
  if (status === "healthy") return "健康";
  if (status === "stopping") return "停止中";
  return "异常";
}

function formatDate(value: string): string { const date = new Date(value); return Number.isNaN(date.valueOf()) ? "时间未知" : date.toLocaleString(); }
function formatPayload(value: Record<string, unknown>): string { try { return JSON.stringify(value, null, 2); } catch { return "内容不可用"; } }
