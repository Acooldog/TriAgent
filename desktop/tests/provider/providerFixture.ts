import type { ProviderManifest } from "../../application/provider/protocols/providerProtocol";

export function providerManifestFixture(providerId = "example.provider"): ProviderManifest {
  return {
    protocol_version: "1",
    provider_id: providerId,
    version: "1.0.0",
    name: "示例 Provider",
    description: "用于验证公开合同。",
    capabilities: [{
      capability_id: "example.echo",
      name: "回显",
      description: "返回结构化结果。",
      input_schema: { type: "object", required: ["text"], additionalProperties: false, properties: { text: { type: "string" } } },
      output_schema: { type: "object", required: ["value"], additionalProperties: false, properties: { value: { type: "string" } } },
      permissions: ["standard", "full"],
      events: ["started", "progress", "completed", "failed", "cancelled"],
      cancellation: true,
      timeout_ms: 100,
    }],
  };
}
