import type { ProviderHealth, ProviderManifest } from "../application/providerProtocol";
import type { ProviderRuntimeDescriptor, ProviderRuntimeExit, ProviderRuntimeGateway, ProviderRuntimeInstance } from "../application/providerRuntimeProtocol";

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
  public constructor(private readonly backend: PrivateProviderRuntimeBackend = new UnconfiguredPrivateBackend()) {}
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
