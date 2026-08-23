import type { ToolManifest } from "./toolProtocol";

export const BUILT_IN_TOOL_MANIFESTS: ToolManifest[] = [
  {
    protocol_version: "1",
    tool_id: "music.scan",
    version: "1.0.0",
    name: "扫描音乐文件",
    description: "扫描用户明确选择的目录并识别音乐格式。",
    input_schema: { type: "object", required: ["path"], additionalProperties: false, properties: { path: { type: "string" } } },
    capabilities: ["music.scan"],
    permissions: ["restricted", "standard", "full"],
    events: ["started", "progress", "finished", "error", "cancelled"],
    cancellation: true,
    timeout_ms: 900_000,
    sensitive_operation: "built-in",
  },
  {
    protocol_version: "1",
    tool_id: "music.decrypt",
    version: "1.0.0",
    name: "解密音乐文件",
    description: "调用已注册的音乐处理工具链解密用户授权的本地文件。",
    input_schema: { type: "object", required: ["path", "platform"], additionalProperties: false, properties: { path: { type: "string" }, platform: { type: "string", enum: ["netease", "qq"] } } },
    capabilities: ["music.decrypt", "music.transcode"],
    permissions: ["standard", "full"],
    events: ["started", "progress", "finished", "error", "cancelled"],
    cancellation: true,
    timeout_ms: 900_000,
    sensitive_operation: "process",
  },
];
