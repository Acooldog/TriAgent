import type { ProviderHealth, ProviderManifest } from "../../../application/provider/protocols/providerProtocol";
import type { ProviderRuntimeDescriptor, ProviderRuntimeExit, ProviderRuntimeGateway, ProviderRuntimeInstance } from "../../../application/provider/protocols/providerRuntimeProtocol";
import { MVP_PROVIDER_ID } from "../constants";
import { MVP_PROVIDER_MANIFEST } from "../mvpProviderManifest";

export interface PrivateProviderRuntimeBackend {
  discover(signal: AbortSignal): Promise<ProviderRuntimeDescriptor[]>;
  start(providerId: string, signal: AbortSignal): Promise<ProviderRuntimeInstance>;
  handshake(providerId: string, instanceId: string, signal: AbortSignal): Promise<ProviderManifest>;
  checkHealth(providerId: string, instanceId: string, signal: AbortSignal): Promise<ProviderHealth>;
  stop(providerId: string, instanceId: string, signal: AbortSignal): Promise<void>;
  cancel(providerId: string, instanceId: string): Promise<boolean>;
  recover(signal: AbortSignal): Promise<ProviderRuntimeInstance[]>;
  onExit(listener: (event: ProviderRuntimeExit) => void): () => void;
}

export class PrivateProviderRuntimeGateway implements ProviderRuntimeGateway {
  public constructor(private readonly backend: PrivateProviderRuntimeBackend = new AuthorizedRuntimeBackend()) {}
  public discover(signal: AbortSignal): Promise<ProviderRuntimeDescriptor[]> { return this.backend.discover(signal); }
  public start(providerId: string, signal: AbortSignal): Promise<ProviderRuntimeInstance> { return this.backend.start(providerId, signal); }
  public handshake(providerId: string, instanceId: string, signal: AbortSignal): Promise<ProviderManifest> { return this.backend.handshake(providerId, instanceId, signal); }
  public checkHealth(providerId: string, instanceId: string, signal: AbortSignal): Promise<ProviderHealth> { return this.backend.checkHealth(providerId, instanceId, signal); }
  public stop(providerId: string, instanceId: string, signal: AbortSignal): Promise<void> { return this.backend.stop(providerId, instanceId, signal); }
  public cancel(providerId: string, instanceId: string): Promise<boolean> { return this.backend.cancel(providerId, instanceId); }
  public recover(signal: AbortSignal): Promise<ProviderRuntimeInstance[]> { return this.backend.recover(signal); }
  public onExit(listener: (event: ProviderRuntimeExit) => void): () => void { return this.backend.onExit(listener); }
}

class UnconfiguredPrivateBackend implements PrivateProviderRuntimeBackend {
  public async discover(_signal: AbortSignal): Promise<ProviderRuntimeDescriptor[]> { return []; }
  public async start(_providerId: string, _signal: AbortSignal): Promise<ProviderRuntimeInstance> { throw new Error("Provider runtime is not configured."); }
  public async handshake(_providerId: string, _instanceId: string, _signal: AbortSignal): Promise<ProviderManifest> { throw new Error("Provider runtime is not configured."); }
  public async checkHealth(_providerId: string, _instanceId: string, _signal: AbortSignal): Promise<ProviderHealth> { throw new Error("Provider runtime is not configured."); }
  public async stop(_providerId: string, _instanceId: string, _signal: AbortSignal): Promise<void> { return undefined; }
  public async cancel(_providerId: string, _instanceId: string): Promise<boolean> { return false; }
  public async recover(_signal: AbortSignal): Promise<ProviderRuntimeInstance[]> { return []; }
  public onExit(_listener: (event: ProviderRuntimeExit) => void): () => void { return () => undefined; }
}

class AuthorizedRuntimeBackend implements PrivateProviderRuntimeBackend {
  private readonly instances = new Map<string, ProviderRuntimeInstance>();
  private readonly listeners = new Set<(event: ProviderRuntimeExit) => void>();
  public async discover(): Promise<ProviderRuntimeDescriptor[]> { return [{ providerId: MVP_PROVIDER_ID, displayName: "本地音乐解密能力", cancellation: true }]; }
  public async start(providerId: string): Promise<ProviderRuntimeInstance> { const instance = { providerId, instanceId: `private-${Date.now()}` }; this.instances.set(providerId, instance); return instance; }
  public async handshake(): Promise<ProviderManifest> { return MVP_PROVIDER_MANIFEST; }
  public async checkHealth(): Promise<ProviderHealth> { return { status: "healthy" }; }
  public async stop(providerId: string): Promise<void> { this.instances.delete(providerId); }
  public async cancel(providerId: string): Promise<boolean> { this.instances.delete(providerId); return true; }
  public async recover(): Promise<ProviderRuntimeInstance[]> { return [...this.instances.values()]; }
  public onExit(listener: (event: ProviderRuntimeExit) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
}
