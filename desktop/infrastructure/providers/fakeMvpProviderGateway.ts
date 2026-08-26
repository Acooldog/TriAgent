import type { ProviderEvent, ProviderGateway, ProviderGatewayResult, ProviderHealth, ProviderInvocationRequest, ProviderManifest } from "../application/provider/providerProtocol";
import { MVP_PROVIDER_MANIFEST } from "./mvpProviderManifest";

export class FakeMvpProviderGateway implements ProviderGateway {
  private readonly cancelled = new Set<string>();
  public async discover(): Promise<ProviderManifest[]> { return [MVP_PROVIDER_MANIFEST]; }
  public async checkHealth(): Promise<ProviderHealth> { return { status: "healthy" }; }
  public async invoke(request: ProviderInvocationRequest, onEvent: (event: ProviderEvent) => void, signal: AbortSignal): Promise<ProviderGatewayResult> {
    const emit = (sequence: number, eventType: string, status: ProviderEvent["status"], payload: Record<string, unknown>, error?: ProviderEvent["error"]): void => onEvent({ protocol_version: "1", request_id: request.requestId, task_id: request.taskId, provider_id: request.providerId, capability_id: request.capabilityId, sequence, event_type: eventType, status, payload, ...(error ? { error } : {}), emitted_at: new Date().toISOString() });
    emit(0, "started", "running", { mode: "fake" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (signal.aborted || this.cancelled.has(request.taskId)) { emit(1, "cancelled", "cancelled", {}, { code: "provider-cancelled", message: "Provider 调用已取消。" }); throw new Error("cancelled"); }
    const input = request.input as Record<string, unknown>;
    const outputPath = `${String(input.outputDir).replace(/[\\/]$/, "")}/sample.m4a`;
    emit(1, "progress", "running", { progress: 0.5 });
    emit(2, "completed", "completed", { outputPath, format: "m4a" });
    return { output: { success: true, outputPath, format: "m4a" }, artifacts: [{ artifact_id: `${request.taskId}-output`, relative_path: "artifacts/sample.m4a", kind: "audio" }] };
  }
  public async cancel(_providerId: string, taskId: string): Promise<boolean> { this.cancelled.add(taskId); return true; }
}
