import type { ModelConfig } from "./modelProtocol";
import type { PermissionMode } from "./toolProtocol";
import { PermissionPolicy } from "./permissionPolicy";

export type DiagnosticStatus = "healthy" | "warning" | "error";
export type DiagnosticCategory = "ffmpeg" | "model" | "worker" | "session" | "provider";

export interface DiagnosticItem {
  category: DiagnosticCategory;
  label: string;
  status: DiagnosticStatus;
  summary: string;
  recoverySuggestion: string;
  checkedAt: string;
}

export interface DiagnosticReport {
  checkedAt: string;
  networkEnabled: boolean;
  logsLocation: string | null;
  items: DiagnosticItem[];
}

export interface DiagnosticContext {
  modelConfig?: ModelConfig;
  networkEnabled: boolean;
  sessionReady: boolean;
  logsLocation: string | null;
}

export interface DiagnosticsRequest {
  modelConfig?: ModelConfig;
  networkEnabled: boolean;
  permissionMode: PermissionMode;
}

export interface DiagnosticGateway {
  checkFfmpeg(): Promise<Omit<DiagnosticItem, "category" | "label" | "checkedAt">>;
  checkModel(config: ModelConfig | undefined, networkEnabled: boolean): Promise<Omit<DiagnosticItem, "category" | "label" | "checkedAt">>;
  checkWorker(): Promise<Omit<DiagnosticItem, "category" | "label" | "checkedAt">>;
  checkProviders(): Promise<Omit<DiagnosticItem, "category" | "label" | "checkedAt">>;
}

export class DiagnosticsService {
  public constructor(private readonly gateway: DiagnosticGateway, private readonly now: () => Date = () => new Date()) {}

  public async run(context: DiagnosticContext): Promise<DiagnosticReport> {
    const checkedAt = this.now().toISOString();
    const definitions: Array<[DiagnosticCategory, string, () => Promise<Omit<DiagnosticItem, "category" | "label" | "checkedAt">>]> = [
      ["ffmpeg", "FFmpeg", () => this.gateway.checkFfmpeg()],
      ["model", "模型连接", () => this.gateway.checkModel(context.modelConfig, context.networkEnabled)],
      ["worker", "Python worker", () => this.gateway.checkWorker()],
      ["provider", "Provider", () => this.gateway.checkProviders()],
    ];
    const items: DiagnosticItem[] = [];
    for (const [category, label, check] of definitions) {
      try {
        items.push({ category, label, checkedAt, ...sanitizeOutcome(await check()) });
      } catch (error) {
        items.push({ category, label, checkedAt, status: "error", summary: redactDiagnosticText(error instanceof Error ? error.message : "健康检查失败。"), recoverySuggestion: recoveryFor(category) });
      }
    }
    items.splice(3, 0, { category: "session", label: "session", checkedAt, status: context.sessionReady ? "healthy" : "warning", summary: context.sessionReady ? "当前 session 可读写。" : "尚未选择可用 session。", recoverySuggestion: context.sessionReady ? "无需处理。" : "请选择工作数据根目录并创建或选择会话。" });
    return { checkedAt, networkEnabled: context.networkEnabled, logsLocation: context.logsLocation, items };
  }
}

export interface ErrorSearchIssue { category: DiagnosticCategory; summary: string; }
export interface ErrorSearchResult { status: "completed" | "stopped"; message: string; results: Array<{ title: string; url: string }>; }
export interface ErrorSearchGateway { search(summary: string, category: DiagnosticCategory): Promise<Array<{ title: string; url: string }>>; }

export class ErrorSearchService {
  public constructor(private readonly gateway: ErrorSearchGateway, private readonly permissions: PermissionPolicy) {}

  public async search(issue: ErrorSearchIssue, mode: PermissionMode, networkEnabled: boolean): Promise<ErrorSearchResult> {
    await this.permissions.authorize({ mode, operation: "network", networkEnabled, title: "错误搜索审批", detail: "仅发送已脱敏的错误分类与摘要。" });
    const summary = redactDiagnosticText(issue.summary).slice(0, 500);
    const results = await this.gateway.search(summary, issue.category);
    return results.length > 0 ? { status: "completed", message: "错误搜索已完成。", results } : { status: "stopped", message: "未找到结果，已停止搜索。", results: [] };
  }
}

export class NoopErrorSearchGateway implements ErrorSearchGateway {
  public async search(): Promise<Array<{ title: string; url: string }>> { return []; }
}

export function redactDiagnosticText(value: string): string {
  return value
    .replace(/([a-zA-Z]:[\\/][^\s,;]+)/g, "[本地路径]")
    .replace(/(authorization|api[-_]?key|token|secret|cookie|credential|session)\s*[:=]\s*[^\s,;]+/gi, "$1=[已脱敏]")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [已脱敏]");
}

function sanitizeOutcome(outcome: Omit<DiagnosticItem, "category" | "label" | "checkedAt">): Omit<DiagnosticItem, "category" | "label" | "checkedAt"> {
  return { ...outcome, summary: redactDiagnosticText(outcome.summary), recoverySuggestion: redactDiagnosticText(outcome.recoverySuggestion) };
}

function recoveryFor(category: DiagnosticCategory): string {
  if (category === "ffmpeg") return "请安装或配置 FFmpeg，并确认当前进程可以访问。";
  if (category === "model") return "请检查模型地址、凭据、联网开关和服务状态。";
  if (category === "worker") return "请检查 Python worker 文件、运行环境和日志。";
  if (category === "session") return "请重新选择工作数据根目录或创建新会话。";
  return "请启动 Provider 并重新执行健康检查。";
}
