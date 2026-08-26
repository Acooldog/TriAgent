import { promises as fs } from "node:fs";
import path from "node:path";
import { ProviderContractError, type ProviderEvent, type ProviderGateway, type ProviderGatewayResult, type ProviderHealth, type ProviderInvocationRequest, type ProviderManifest } from "../../application/provider/providerProtocol";
import type { WorkerEvent } from "../../application/worker/workerProtocol";
import type { WorkerService } from "../../application/worker/workerService";
import { selectKugouProvider } from "./decryptionProviderPolicy";
import { MVP_PROVIDER_MANIFEST } from "./mvpProviderManifest";
import { decryptUnlockMusicKgm, UnlockMusicUnsupportedError } from "../unlockMusicKgm";
import { debugError, debugInfo } from "../logging/debugLogger";

export class AuthorizedMvpProviderGateway implements ProviderGateway {
  private readonly worker: WorkerService;
  private readonly active = new Map<string, string>();
  private readonly cancelled = new Set<string>();

  /** @param worker 由组合根（presentation/main.ts）注入的 WorkerService 实例 */
  public constructor(worker: WorkerService) {
    this.worker = worker;
  }

  public async discover(): Promise<ProviderManifest[]> { return [MVP_PROVIDER_MANIFEST]; }
  public async checkHealth(): Promise<ProviderHealth> { debugInfo("private-provider", "health"); return { status: "healthy" }; }

  public async invoke(request: ProviderInvocationRequest, onEvent: (event: ProviderEvent) => void, signal: AbortSignal): Promise<ProviderGatewayResult> {
    debugInfo("private-provider", "invoke", { providerId: request.providerId, capabilityId: request.capabilityId, taskId: request.taskId, platform: (request.input as Record<string, unknown>).platform });
    const input = request.input as Record<string, unknown>;
    const outputDir = String(input.outputDir);
    const before = await listFiles(outputDir);
    const primary = selectKugouProvider([{ kind: "primary", available: String(input.platform).toLowerCase() === "kugou" }, { kind: "fallback", available: true }]);
    if (primary.kind === "primary") {
      try { debugInfo("private-provider", "primary-start", { taskId: request.taskId }); return await this.invokeUnlockMusic(request, String(input.inputPath), outputDir, onEvent, signal); }
      catch (error) { if (!(error instanceof UnlockMusicUnsupportedError)) { debugError("private-provider", "primary-error", error, { taskId: request.taskId }); throw error; } debugInfo("private-provider", "primary-unsupported", { taskId: request.taskId }); }
    }
    let sequence = 0;
    const handle = this.worker.start("decrypt", { platform: String(input.platform), input_path: String(input.inputPath), output_dir: outputDir, recursive: Boolean(input.recursive), settings: { transcode_enabled: false, decryption_priority: "primary-authorized-logic" } }, (event) => onEvent(this.mapEvent(request, event, sequence++)), { timeoutMs: request.timeoutMs });
    this.active.set(request.taskId, handle.taskId);
    const abort = () => { this.cancel(request.providerId, request.taskId); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      debugInfo("private-provider", "fallback-start", { taskId: request.taskId }); const completion = await handle.completion;
      if (completion.status === "cancelled" || this.cancelled.has(request.taskId)) throw new ProviderContractError("provider-cancelled", "Provider 调用已取消。");
      if (completion.status !== "completed" || completion.resultCode !== 0) throw new ProviderContractError("provider-execution-failed", "本地解密未成功完成。");
      const outputPath = await findNewFile(outputDir, before);
      if (!outputPath) throw new ProviderContractError("provider-output-invalid", "未找到可验证的解密输出文件。");
      debugInfo("private-provider", "fallback-complete", { taskId: request.taskId, format: path.extname(outputPath).slice(1).toLowerCase() }); return { output: { success: true, outputPath, format: path.extname(outputPath).slice(1).toLowerCase() || "audio" }, artifacts: [{ artifact_id: `${request.taskId}-output`, relative_path: toRelative(outputDir, outputPath), kind: "audio" }] };
    } finally { signal.removeEventListener("abort", abort); this.active.delete(request.taskId); }
  }

  private async invokeUnlockMusic(request: ProviderInvocationRequest, inputPath: string, outputDir: string, onEvent: (event: ProviderEvent) => void, signal: AbortSignal): Promise<ProviderGatewayResult> {
    if (!/\.(?:kgm|kgma)$/i.test(inputPath)) throw new UnlockMusicUnsupportedError("主解密逻辑不支持此格式。");
    if (signal.aborted) throw new ProviderContractError("provider-cancelled", "Provider 调用已取消。");
    let sequence = 0;
    const emit = (eventType: string, status: ProviderEvent["status"], payload: Record<string, unknown>) => onEvent({ protocol_version: "1", request_id: request.requestId, task_id: request.taskId, provider_id: request.providerId, capability_id: request.capabilityId, sequence: sequence++, event_type: eventType, status, payload, emitted_at: new Date().toISOString() });
    emit("started", "running", { engine: "primary" });
    const encrypted = new Uint8Array(await fs.readFile(inputPath));
    const decoded = decryptUnlockMusicKgm(encrypted);
    if (signal.aborted) throw new ProviderContractError("provider-cancelled", "Provider 调用已取消。");
    const extension = detectAudioExtension(decoded);
    if (extension === "bin") throw new ProviderContractError("provider-output-invalid", "主解密逻辑未生成可识别音频输出。");
    await fs.mkdir(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, `${path.basename(inputPath).replace(/\.(?:kgm|kgma)$/i, "")}.${extension}`);
    await fs.writeFile(outputPath, decoded);
    emit("progress", "running", { progress: 1, engine: "primary" });
    emit("completed", "completed", { outputPath, format: extension, engine: "primary" });
    debugInfo("private-provider", "primary-complete", { taskId: request.taskId, format: extension }); return { output: { success: true, outputPath, format: extension }, artifacts: [{ artifact_id: `${request.taskId}-output`, relative_path: toRelative(outputDir, outputPath), kind: "audio" }] };
  }

  public async cancel(_providerId: string, taskId: string): Promise<boolean> { const workerTaskId = this.active.get(taskId); if (!workerTaskId) return false; this.cancelled.add(taskId); return this.worker.cancel(workerTaskId); }

  private mapEvent(request: ProviderInvocationRequest, event: WorkerEvent, sequence: number): ProviderEvent {
    const terminal = event.event_type === "worker_finished";
    const status = event.status === "cancelled" ? "cancelled" : event.status === "failed" ? "failed" : terminal ? "completed" : "running";
    const eventType = status === "completed" ? "completed" : status === "failed" ? "failed" : status === "cancelled" ? "cancelled" : event.event_type === "worker_started" ? "started" : "progress";
    return { protocol_version: "1", request_id: request.requestId, task_id: request.taskId, provider_id: request.providerId, capability_id: request.capabilityId, sequence, event_type: eventType, status, payload: event.payload, ...(event.error ? { error: { code: event.error.code, message: event.error.message } } : {}), emitted_at: event.emitted_at };
  }
}

async function listFiles(directory: string): Promise<Set<string>> { try { return new Set((await fs.readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => path.join(directory, entry.name))); } catch { return new Set(); } }
async function findNewFile(directory: string, before: Set<string>): Promise<string | undefined> { const files = await listFiles(directory); return [...files].find((file) => !before.has(file)); }
function toRelative(root: string, file: string): string { return path.relative(root, file).replaceAll(path.sep, "/") || path.basename(file); }
function detectAudioExtension(value: Uint8Array): string { if (value[0] === 0x49 && value[1] === 0x44 && value[2] === 0x33) return "mp3"; if (value[0] === 0x52 && value[1] === 0x49 && value[2] === 0x46 && value[8] === 0x57) return "wav"; if (value[0] === 0x4f && value[1] === 0x67 && value[2] === 0x67 && value[3] === 0x53) return "ogg"; if (value.slice(4, 8).every((byte, index) => byte === [0x66, 0x74, 0x79, 0x70][index])) return "m4a"; return "bin"; }
