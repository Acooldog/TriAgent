import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DiagnosticGateway, DiagnosticItem } from "../application/diagnostics";
import type { ModelConfig } from "../application/modelProtocol";
import type { ProviderRuntimeState } from "../application/providerRuntimeProtocol";

const execFileAsync = promisify(execFile);
type Outcome = Omit<DiagnosticItem, "category" | "label" | "checkedAt">;

export interface SystemDiagnosticsOptions {
  ffmpegExecutable?: string;
  fetcher?: typeof fetch;
  checkWorker: () => Promise<boolean>;
  listProviderStates: () => ProviderRuntimeState[];
}

export class SystemDiagnosticsGateway implements DiagnosticGateway {
  private readonly ffmpegExecutable: string;
  private readonly fetcher: typeof fetch;

  public constructor(private readonly options: SystemDiagnosticsOptions) {
    this.ffmpegExecutable = options.ffmpegExecutable ?? "ffmpeg";
    this.fetcher = options.fetcher ?? fetch;
  }

  public async checkFfmpeg(): Promise<Outcome> {
    try {
      await execFileAsync(this.ffmpegExecutable, ["-version"], { timeout: 5_000, windowsHide: true });
      return healthy("FFmpeg 可用。");
    } catch {
      return failed("未找到可用的 FFmpeg。", "请安装或配置 FFmpeg，并确认当前进程可以访问。");
    }
  }

  public async checkModel(config: ModelConfig | undefined, networkEnabled: boolean): Promise<Outcome> {
    if (!networkEnabled) return warning("联网已关闭，未检查模型连接。", "如需检查模型，请先启用当前会话联网。");
    if (!config?.baseUrl || !config.model) return warning("模型配置不完整。", "请填写模型地址和模型名。");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
      for (const [key, value] of Object.entries(config.headers ?? {})) headers[key] = value;
      const response = await this.fetcher(`${config.baseUrl.replace(/\/+$/, "")}/models`, { headers, signal: controller.signal });
      if (!response.ok) return failed(`模型服务返回 HTTP ${response.status}。`, "请检查模型地址、凭据和服务状态。");
      return healthy("模型服务连接正常。");
    } catch {
      return failed("模型服务连接失败。", "请检查模型地址、联网设置和服务状态。");
    } finally { clearTimeout(timer); }
  }

  public async checkWorker(): Promise<Outcome> {
    try {
      return await this.options.checkWorker() ? healthy("Python worker 可用。") : failed("Python worker 未通过检查。", "请检查 worker 文件和 Python 运行环境。");
    } catch {
      return failed("Python worker 启动失败。", "请检查 worker 文件、运行环境和日志。");
    }
  }

  public async checkProviders(): Promise<Outcome> {
    const states = this.options.listProviderStates().filter((item) => item.providerId !== null);
    if (states.length === 0) return warning("未配置 Provider。", "如需外部能力，请先配置并启动 Provider。");
    const unhealthy = states.filter((item) => item.status !== "healthy");
    return unhealthy.length === 0 ? healthy("所有 Provider 均健康。") : warning(`${unhealthy.length} 个 Provider 当前不可用。`, "请启动 Provider 并重新执行健康检查。");
  }
}

function healthy(summary: string): Outcome { return { status: "healthy", summary, recoverySuggestion: "无需处理。" }; }
function warning(summary: string, recoverySuggestion: string): Outcome { return { status: "warning", summary, recoverySuggestion }; }
function failed(summary: string, recoverySuggestion: string): Outcome { return { status: "error", summary, recoverySuggestion }; }
