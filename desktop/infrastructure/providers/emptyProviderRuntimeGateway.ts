import { ProviderRuntimeError, type ProviderRuntimeDescriptor, type ProviderRuntimeExit, type ProviderRuntimeGateway, type ProviderRuntimeInstance } from "../../application/provider/providerRuntimeProtocol";
import type { ProviderHealth, ProviderManifest } from "../../application/provider/providerProtocol";

export class EmptyProviderRuntimeGateway implements ProviderRuntimeGateway {
  public async discover(_signal: AbortSignal): Promise<ProviderRuntimeDescriptor[]> { return []; }
  public async start(_providerId: string, _signal: AbortSignal): Promise<ProviderRuntimeInstance> { throw unconfigured(); }
  public async handshake(_providerId: string, _instanceId: string, _signal: AbortSignal): Promise<ProviderManifest> { throw unconfigured(); }
  public async checkHealth(_providerId: string, _instanceId: string, _signal: AbortSignal): Promise<ProviderHealth> { throw unconfigured(); }
  public async stop(_providerId: string, _instanceId: string, _signal: AbortSignal): Promise<void> { throw unconfigured(); }
  public async cancel(_providerId: string, _instanceId: string): Promise<boolean> { return false; }
  public async recover(_signal: AbortSignal): Promise<ProviderRuntimeInstance[]> { return []; }
  public onExit(_listener: (event: ProviderRuntimeExit) => void): () => void { return () => undefined; }
}

function unconfigured(): ProviderRuntimeError { return new ProviderRuntimeError("provider-runtime-unconfigured", "当前未配置能力 Provider。", "discover"); }
