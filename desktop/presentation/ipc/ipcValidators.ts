/** IPC validation helpers — extracted from ipcHandlers.ts for SRP. */
import type { CompressionOptions } from "../../application/settings/contextCompression";
import type { DiagnosticsRequest, ErrorSearchIssue } from "../../application/diagnostics";
import type { ModelConfig, ChatMessage } from "../../application/model/modelProtocol";
import type { ToolManifest } from "../../application/tools/toolProtocol";

export function validateManifest(manifest: ToolManifest): void {
  if (!manifest.name || !manifest.description) throw new Error("工具清单缺少必填字段。");
}

export function parseDiagnosticsRequest(value: unknown): DiagnosticsRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("诊断请求无效。");
  const request = value as Record<string, unknown>;
  if (typeof request.networkEnabled !== "boolean" || (request.permissionMode !== "restricted" && request.permissionMode !== "standard" && request.permissionMode !== "full")) throw new Error("诊断设置无效。");
  if (request.modelConfig !== undefined && !isModelConfig(request.modelConfig)) throw new Error("模型配置无效。");
  return { networkEnabled: request.networkEnabled, permissionMode: request.permissionMode, ...(request.modelConfig ? { modelConfig: request.modelConfig } : {}) };
}

export function parseErrorSearchIssue(value: unknown): ErrorSearchIssue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("错误搜索请求无效。");
  const issue = value as Record<string, unknown>;
  if (!isDiagnosticCategory(issue.category) || typeof issue.summary !== "string" || !issue.summary.trim()) throw new Error("错误搜索摘要无效。");
  return { category: issue.category, summary: issue.summary };
}

export function isDiagnosticCategory(value: unknown): value is ErrorSearchIssue["category"] {
  return value === "ffmpeg" || value === "model" || value === "worker" || value === "session" || value === "provider";
}

export function isCompressionOptions(value: unknown): value is CompressionOptions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const options = value as Record<string, unknown>;
  return typeof options.thresholdTokens === "number" && Number.isFinite(options.thresholdTokens) && options.thresholdTokens > 0
    && typeof options.preserveRecentMessages === "number" && Number.isInteger(options.preserveRecentMessages) && options.preserveRecentMessages >= 1
    && (options.markdownThresholdTokens === undefined || typeof options.markdownThresholdTokens === "number" && Number.isFinite(options.markdownThresholdTokens) && options.markdownThresholdTokens > 0)
    && (options.markdownMaxRatio === undefined || typeof options.markdownMaxRatio === "number" && options.markdownMaxRatio > 0 && options.markdownMaxRatio < 1)
    && (options.writeMarkdown === undefined || typeof options.writeMarkdown === "boolean");
}

export function isModelConfig(value: unknown): value is ModelConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  if (typeof config.baseUrl !== "string" || !config.baseUrl.trim() || typeof config.model !== "string" || !config.model.trim()) return false;
  if (config.apiKey !== undefined && typeof config.apiKey !== "string") return false;
  if (config.headers !== undefined && (typeof config.headers !== "object" || config.headers === null || Array.isArray(config.headers))) return false;
  for (const key of ["maxTokens", "temperature", "connectTimeoutMs", "firstByteTimeoutMs", "readTimeoutMs", "totalTimeoutMs"]) {
    if (config[key] !== undefined && (typeof config[key] !== "number" || !Number.isFinite(config[key]))) return false;
  }
  return config.thinking === undefined || config.thinking === "enabled" || config.thinking === "disabled";
}

export function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isChatMessage(value: unknown): value is ChatMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  return ["system", "user", "assistant", "tool"].includes(String(message.role))
    && (typeof message.content === "string" || message.content === null);
}

export function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "model-error";
}
