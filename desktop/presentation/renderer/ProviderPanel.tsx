import { useEffect, useState, type ReactElement } from "react";
import type { ProviderEvent, ProviderRegistration } from "../../application/providerProtocol";

export function ProviderPanel(): ReactElement {
  const [providers, setProviders] = useState<ProviderRegistration[]>([]);
  const [events, setEvents] = useState<ProviderEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    const unsubscribe = window.triMusicAgent.onProviderEvent((event) => { if (active) setEvents((current) => [...current.slice(-29), event]); });
    void window.triMusicAgent.listProviders().then((items) => { if (active) setProviders(items); });
    return () => { active = false; unsubscribe(); };
  }, []);

  const refresh = async () => {
    setBusy(true); setMessage("");
    try {
      const items = await window.triMusicAgent.refreshProviders();
      setProviders(items);
      setMessage(items.length ? "Provider 清单和健康状态已刷新。" : "未发现可用的 Provider。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Provider 刷新失败。"); }
    finally { setBusy(false); }
  };

  const toggle = async (registration: ProviderRegistration) => {
    try {
      const updated = await window.triMusicAgent.setProviderEnabled(registration.manifest.provider_id, !registration.enabled);
      setProviders((current) => current.map((item) => item.manifest.provider_id === updated.manifest.provider_id ? updated : item));
    } catch (error) { setMessage(error instanceof Error ? error.message : "Provider 设置失败。"); }
  };

  const checkHealth = async (providerId: string) => {
    try {
      const updated = await window.triMusicAgent.checkProviderHealth(providerId);
      setProviders((current) => current.map((item) => item.manifest.provider_id === providerId ? updated : item));
    } catch (error) { setMessage(error instanceof Error ? error.message : "Provider 健康检查失败。"); }
  };

  return <section className="sessions-panel provider-panel">
    <div className="panel-heading">
      <div><h2>外部能力 Provider</h2><p>仅显示已通过合同校验的能力和脱敏事件。</p></div>
      <button type="button" onClick={() => void refresh()} disabled={busy}>刷新清单</button>
    </div>
    {message ? <p className="message provider-message">{message}</p> : null}
    {providers.length === 0 ? <div className="empty-state">暂无已注册的 Provider。</div> : <div className="provider-list">{providers.map((registration) => <article className="provider-row" key={registration.manifest.provider_id}>
      <div className="provider-summary"><div><strong>{registration.manifest.name}</strong><small>{registration.manifest.provider_id} · 版本 {registration.manifest.version}</small></div><span className={`health health-${registration.health.status}`}>{healthLabel(registration.health.status)}</span></div>
      <p>{registration.manifest.capabilities.map((capability) => capability.name).join("、")}</p>
      {registration.health.message ? <p className="provider-health-message">{registration.health.message}</p> : null}
      <div className="worker-actions"><button type="button" onClick={() => void checkHealth(registration.manifest.provider_id)}>检查状态</button><button type="button" onClick={() => void toggle(registration)}>{registration.enabled ? "禁用" : "启用"}</button></div>
    </article>)}</div>}
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

function formatDate(value: string): string { const date = new Date(value); return Number.isNaN(date.valueOf()) ? "时间未知" : date.toLocaleString(); }
function formatPayload(value: Record<string, unknown>): string { try { return JSON.stringify(value, null, 2); } catch { return "内容不可用"; } }
