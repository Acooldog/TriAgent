import { ProviderContractError, validateProviderInput, validateProviderManifest, type ProviderCall, type ProviderCapabilityManifest, type ProviderHealth, type ProviderManifest, type ProviderRegistration } from "./protocols/providerProtocol";

export class ProviderRegistry {
  private readonly registrations = new Map<string, ProviderRegistration>();

  public register(manifest: ProviderManifest): void {
    validateProviderManifest(manifest);
    if (this.registrations.has(manifest.provider_id)) throw new ProviderContractError("provider-duplicate", `Provider ${manifest.provider_id} 重复注册。`);
    this.registrations.set(manifest.provider_id, registration(manifest));
  }

  public upsert(manifest: ProviderManifest): ProviderRegistration {
    validateProviderManifest(manifest);
    const current = this.registrations.get(manifest.provider_id);
    const next: ProviderRegistration = { manifest: structuredClone(manifest), enabled: current?.enabled ?? true, health: current?.health ?? { status: "unknown" } };
    this.registrations.set(manifest.provider_id, next);
    return structuredClone(next);
  }

  public refresh(manifests: ProviderManifest[]): void {
    const incoming = new Map<string, ProviderManifest>();
    for (const manifest of manifests) {
      validateProviderManifest(manifest);
      if (incoming.has(manifest.provider_id)) throw new ProviderContractError("provider-duplicate", `Provider ${manifest.provider_id} 重复注册。`);
      incoming.set(manifest.provider_id, structuredClone(manifest));
    }
    const next = new Map<string, ProviderRegistration>();
    for (const [providerId, manifest] of incoming) {
      const existing = this.registrations.get(providerId);
      next.set(providerId, { manifest, enabled: existing?.enabled ?? true, health: existing?.health ?? { status: "unknown" } });
    }
    this.registrations.clear();
    for (const [providerId, value] of next) this.registrations.set(providerId, value);
  }

  public list(): ProviderRegistration[] {
    return [...this.registrations.values()].map((item) => structuredClone(item));
  }

  public setEnabled(providerId: string, enabled: boolean): ProviderRegistration {
    const current = this.requireRegistration(providerId);
    const next = { ...current, enabled };
    this.registrations.set(providerId, next);
    return structuredClone(next);
  }

  public setHealth(providerId: string, health: ProviderHealth): ProviderRegistration {
    const current = this.requireRegistration(providerId);
    const next = { ...current, health: structuredClone(health) };
    this.registrations.set(providerId, next);
    return structuredClone(next);
  }

  public resolve(call: ProviderCall): { registration: ProviderRegistration; capability: ProviderCapabilityManifest } {
    const registrationValue = this.requireRegistration(call.providerId);
    if (!registrationValue.enabled) throw new ProviderContractError("provider-disabled", `Provider ${call.providerId} 已禁用。`);
    if (registrationValue.health.status !== "healthy") throw new ProviderContractError("provider-unhealthy", registrationValue.health.message || `Provider ${call.providerId} 当前不可用。`);
    const capability = registrationValue.manifest.capabilities.find((item) => item.capability_id === call.capabilityId);
    if (!capability) throw new ProviderContractError("provider-capability-missing", `Provider ${call.providerId} 未声明能力 ${call.capabilityId}。`);
    if (!capability.permissions.includes(call.permissionMode)) throw new ProviderContractError("provider-permission-denied", "当前权限模式不足，Provider 调用已拒绝。");
    validateProviderInput(capability, call.input);
    return { registration: structuredClone(registrationValue), capability: structuredClone(capability) };
  }

  private requireRegistration(providerId: string): ProviderRegistration {
    const registrationValue = this.registrations.get(providerId);
    if (!registrationValue) throw new ProviderContractError("provider-missing", `Provider ${providerId} 未注册。`);
    return registrationValue;
  }
}

function registration(manifest: ProviderManifest): ProviderRegistration {
  return { manifest: structuredClone(manifest), enabled: true, health: { status: "unknown" } };
}
