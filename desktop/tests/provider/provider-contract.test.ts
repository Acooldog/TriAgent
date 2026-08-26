import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderContractError, normalizeProviderError, sanitizeProviderData, validateProviderManifest, validateProviderOutput, type ProviderManifest } from "../application/provider/providerProtocol";
import { ProviderRegistry } from "../application/providerRegistry";
import { providerManifestFixture as manifest } from "./providerFixture";
import { validateJsonValue } from "../application/tools/jsonSchema";

test("registers a valid provider manifest", () => {
  const registry = new ProviderRegistry();
  registry.register(manifest());
  assert.equal(registry.list()[0]?.manifest.provider_id, "example.provider");
  assert.equal(registry.list()[0]?.health.status, "unknown");
});

test("rejects incompatible protocol versions", () => {
  const incompatible = { ...manifest(), protocol_version: "2" };
  assert.throws(() => validateProviderManifest(incompatible), (error: unknown) => error instanceof ProviderContractError && error.code === "provider-incompatible");
});

test("rejects duplicate provider ids", () => {
  const registry = new ProviderRegistry();
  registry.register(manifest());
  assert.throws(() => registry.register(manifest()), (error: unknown) => error instanceof ProviderContractError && error.code === "provider-duplicate");
});

test("validates invocation input and provider output schemas", () => {
  const registry = new ProviderRegistry();
  registry.register(manifest());
  registry.setHealth("example.provider", { status: "healthy" });
  assert.doesNotThrow(() => registry.resolve({ providerId: "example.provider", capabilityId: "example.echo", input: { text: "ok" }, permissionMode: "standard" }));
  assert.throws(() => registry.resolve({ providerId: "example.provider", capabilityId: "example.echo", input: { text: 1 }, permissionMode: "standard" }), (error: unknown) => error instanceof ProviderContractError && error.code === "provider-input-schema");
  const capability = manifest().capabilities[0];
  assert.doesNotThrow(() => validateProviderOutput(capability, { value: "ok" }));
  assert.throws(() => validateProviderOutput(capability, { value: 1 }), (error: unknown) => error instanceof ProviderContractError && error.code === "provider-output-schema");
});

test("rejects calls without sufficient permission", () => {
  const registry = new ProviderRegistry();
  registry.register(manifest());
  registry.setHealth("example.provider", { status: "healthy" });
  assert.throws(() => registry.resolve({ providerId: "example.provider", capabilityId: "example.echo", input: { text: "ok" }, permissionMode: "restricted" }), (error: unknown) => error instanceof ProviderContractError && error.code === "provider-permission-denied");
});

test("does not resolve disabled providers", () => {
  const registry = new ProviderRegistry();
  registry.register(manifest());
  registry.setHealth("example.provider", { status: "healthy" });
  registry.setEnabled("example.provider", false);
  assert.throws(() => registry.resolve({ providerId: "example.provider", capabilityId: "example.echo", input: { text: "ok" }, permissionMode: "standard" }), (error: unknown) => error instanceof ProviderContractError && error.code === "provider-disabled");
});

test("rejects missing and unhealthy providers", () => {
  const registry = new ProviderRegistry();
  assert.throws(() => registry.resolve({ providerId: "missing.provider", capabilityId: "example.echo", input: {}, permissionMode: "standard" }), (error: unknown) => error instanceof ProviderContractError && error.code === "provider-missing");
  registry.register(manifest());
  registry.setHealth("example.provider", { status: "unhealthy", message: "健康检查失败。" });
  assert.throws(() => registry.resolve({ providerId: "example.provider", capabilityId: "example.echo", input: { text: "ok" }, permissionMode: "standard" }), (error: unknown) => error instanceof ProviderContractError && error.code === "provider-unhealthy");
});

test("keeps existing registrations when refresh validation fails", () => {
  const registry = new ProviderRegistry();
  registry.register(manifest());
  const invalid = { ...manifest("broken.provider"), protocol_version: "2" };
  assert.throws(() => registry.refresh([invalid as unknown as ProviderManifest]));
  assert.deepEqual(registry.list().map((item) => item.manifest.provider_id), ["example.provider"]);
});

test("normalizes provider errors without exposing sensitive values", () => {
  const normalized = normalizeProviderError(new ProviderContractError("provider-execution-failed", "token=private-value"));
  assert.equal(normalized.code, "provider-execution-failed");
  assert.doesNotMatch(normalized.message, /private-value/);
  const unknown = normalizeProviderError(new Error("internal path and implementation detail"));
  assert.equal(unknown.message, "Provider 执行失败。");
  const path = normalizeProviderError(new ProviderContractError("provider-execution-failed", "路径=C:\\Users\\name\\My Music\\private.txt"));
  assert.doesNotMatch(path.message, /Users|Music|private\.txt/);
});

test("rejects non-finite JSON numbers", () => {
  assert.deepEqual(validateJsonValue({ type: "number" }, Number.NaN, "value"), ["value 类型应为 number"]);
  assert.deepEqual(validateJsonValue({ type: "number" }, Number.POSITIVE_INFINITY, "value"), ["value 类型应为 number"]);
});

test("rejects cyclic schemas and sanitizes cyclic payloads", () => {
  const cyclicSchema: Record<string, unknown> = { type: "object", properties: {} };
  (cyclicSchema.properties as Record<string, unknown>).self = cyclicSchema;
  const invalid = manifest();
  invalid.capabilities[0].input_schema = cyclicSchema as never;
  assert.throws(() => validateProviderManifest(invalid), (error: unknown) => error instanceof ProviderContractError && error.code === "provider-schema-invalid");
  const invalidEnum = manifest();
  invalidEnum.capabilities[0].input_schema = { type: "number", enum: [Number.NaN] };
  assert.throws(() => validateProviderManifest(invalidEnum), (error: unknown) => error instanceof ProviderContractError && error.code === "provider-schema-invalid");
  const cyclicPayload: Record<string, unknown> = { value: "ok" };
  cyclicPayload.self = cyclicPayload;
  assert.deepEqual(sanitizeProviderData(cyclicPayload), { value: "ok", self: "[循环引用已脱敏]" });
});
