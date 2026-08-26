import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderHealth, ProviderManifest } from "../../application/provider/providerProtocol";
import type { ProviderRuntimeDescriptor, ProviderRuntimeExit, ProviderRuntimeInstance } from "../../application/provider/providerRuntimeProtocol";
import { PrivateProviderRuntimeGateway, type PrivateProviderRuntimeBackend } from "../../infrastructure/providers/privateProviderRuntimeGateway";
import { providerManifestFixture } from "./providerFixture";

class BackendFixture implements PrivateProviderRuntimeBackend {
  public exits = new Set<(event: ProviderRuntimeExit) => void>();
  public async discover(): Promise<ProviderRuntimeDescriptor[]> { return [{ providerId: "private.fixture", displayName: "私有测试 Provider", cancellation: true }]; }
  public async start(providerId: string): Promise<ProviderRuntimeInstance> { return { providerId, instanceId: "instance-1" }; }
  public async handshake(): Promise<ProviderManifest> { return providerManifestFixture("private.fixture"); }
  public async checkHealth(): Promise<ProviderHealth> { return { status: "healthy" }; }
  public async stop(): Promise<void> { return undefined; }
  public async cancel(): Promise<boolean> { return true; }
  public async recover(): Promise<ProviderRuntimeInstance[]> { return [{ providerId: "private.fixture", instanceId: "instance-1" }]; }
  public onExit(listener: (event: ProviderRuntimeExit) => void): () => void { this.exits.add(listener); return () => this.exits.delete(listener); }
}

test("keeps the private runtime implementation behind the public gateway boundary", async () => {
  const backend = new BackendFixture(); const gateway = new PrivateProviderRuntimeGateway(backend); const controller = new AbortController();
  assert.equal((await gateway.discover(controller.signal))[0]?.providerId, "private.fixture");
  assert.equal((await gateway.start("private.fixture", controller.signal)).instanceId, "instance-1");
  assert.equal((await gateway.handshake("private.fixture", "instance-1", controller.signal)).provider_id, "private.fixture");
  assert.equal((await gateway.checkHealth("private.fixture", "instance-1", controller.signal)).status, "healthy");
  assert.equal(await gateway.cancel("private.fixture", "instance-1"), true);
  assert.equal((await gateway.recover(controller.signal))[0]?.instanceId, "instance-1");
});
