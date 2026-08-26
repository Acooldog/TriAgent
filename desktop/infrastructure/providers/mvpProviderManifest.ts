import type { ProviderManifest } from "../application/provider/providerProtocol";
import { MVP_CAPABILITY_ID, MVP_PROVIDER_ID } from "../application/agentTaskService";

export const MVP_PROVIDER_MANIFEST: ProviderManifest = {
  protocol_version: "1",
  provider_id: MVP_PROVIDER_ID,
  version: "1.0.0",
  name: "本地音乐解密能力",
  description: "处理一个已授权的本地音乐样本并输出稳定音频文件。",
  capabilities: [{
    capability_id: MVP_CAPABILITY_ID,
    name: "解密本地音乐",
    description: "读取指定样本并写入解密结果。",
    input_schema: { type: "object", required: ["platform", "inputPath", "outputDir"], additionalProperties: false, properties: { platform: { type: "string", enum: ["kugou"] }, inputPath: { type: "string" }, outputDir: { type: "string" }, recursive: { type: "boolean" } } },
    output_schema: { type: "object", required: ["success", "outputPath", "format"], additionalProperties: false, properties: { success: { type: "boolean" }, outputPath: { type: "string" }, format: { type: "string" } } },
    permissions: ["standard", "full"],
    events: ["started", "progress", "completed", "failed", "cancelled"],
    cancellation: true,
    timeout_ms: 15 * 60 * 1000,
  }],
};
