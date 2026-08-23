import type { ProviderHealth, ProviderManifest } from "../application/providerProtocol";
import type { ProviderRuntimeDescriptor, ProviderRuntimeExit, ProviderRuntimeGateway, ProviderRuntimeInstance } from "../application/providerRuntimeProtocol";
import { MVP_PROVIDER_ID } from "../application/agentTaskService";
import { MVP_PROVIDER_MANIFEST } from "./mvpProviderManifest";

export class FakeMvpProviderRuntimeGateway implements ProviderRuntimeGateway {
  private readonly instances = new Map<string, ProviderRuntimeInstance>();
  private readonly listeners = new Set<(event: ProviderRuntimeExit) => void>();
  public async discover(): Promise<ProviderRuntimeDescriptor[]> { return [{ providerId: MVP_PROVIDER_ID, displayName: "本地音乐解密能力", cancellation: true }]; }
  public async start(providerId: string): Promise<ProviderRuntimeInstance> { const instance = { providerId, instanceId: `fake-${Date.now()}` }; this.instances.set(providerId, instance); return instance; }
  public async handshake(): Promise<ProviderManifest> { return MVP_PROVIDER_MANIFEST; }
  public async checkHealth(): Promise<ProviderHealth> { return { status: "healthy" }; }
  public async stop(providerId: string): Promise<void> { this.instances.delete(providerId); }
  public async cancel(providerId: string): Promise<boolean> { this.instances.delete(providerId); return true; }
  public async recover(): Promise<ProviderRuntimeInstance[]> { return [...this.instances.values()]; }
  public onExit(listener: (event: ProviderRuntimeExit) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
}
