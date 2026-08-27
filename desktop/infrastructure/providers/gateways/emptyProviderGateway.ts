import { ProviderContractError, type ProviderEvent, type ProviderGateway, type ProviderGatewayResult, type ProviderHealth, type ProviderInvocationRequest, type ProviderManifest } from "../../../application/provider/protocols/providerProtocol";

export class EmptyProviderGateway implements ProviderGateway {
  public async discover(): Promise<ProviderManifest[]> { return []; }
  public async checkHealth(providerId: string): Promise<ProviderHealth> { throw new ProviderContractError("provider-missing", `Provider ${providerId} 未连接。`); }
  public async invoke(_request: ProviderInvocationRequest, _onEvent: (event: ProviderEvent) => void, _signal: AbortSignal): Promise<ProviderGatewayResult> { throw new ProviderContractError("provider-missing", "Provider 未连接。"); }
  public async cancel(): Promise<boolean> { return false; }
}
