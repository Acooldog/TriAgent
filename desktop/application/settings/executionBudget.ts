export interface ExecutionLimits {
  maxStepRetries: number;
  maxModelTurns: number;
  maxToolCalls: number;
  totalTimeoutMs: number;
}

export const DEFAULT_EXECUTION_LIMITS: ExecutionLimits = {
  maxStepRetries: 2,
  maxModelTurns: 8,
  maxToolCalls: 16,
  totalTimeoutMs: 15 * 60 * 1_000,
};

export type ExecutionStopCode = "task-timeout" | "task-cancelled" | "repeated-error" | "retry-budget-exhausted" | "model-budget-exhausted" | "tool-budget-exhausted";

export class ExecutionBudgetError extends Error {
  public constructor(public readonly code: ExecutionStopCode, message: string) {
    super(message);
    this.name = "ExecutionBudgetError";
  }
}

export interface ExecutionBudgetSnapshot {
  modelTurns: number;
  toolCalls: number;
  elapsedMs: number;
  stopped: boolean;
  stopCode?: ExecutionStopCode;
}

export class ExecutionBudget {
  private readonly startedAt: number;
  private readonly retries = new Map<string, number>();
  private modelTurns = 0;
  private toolCalls = 0;
  private lastErrorSignature: string | null = null;
  private stopError: ExecutionBudgetError | null = null;

  public constructor(private readonly limits: ExecutionLimits = DEFAULT_EXECUTION_LIMITS, private readonly now: () => number = Date.now) {
    this.startedAt = now();
  }

  public recordModelTurn(): void {
    this.assertActive();
    this.modelTurns += 1;
    if (this.modelTurns > this.limits.maxModelTurns) this.stop("model-budget-exhausted", `模型交互已达到 ${this.limits.maxModelTurns} 轮上限。`);
  }

  public recordToolCalls(count = 1): void {
    this.assertActive();
    if (!Number.isInteger(count) || count < 0) throw new Error("工具调用计数必须是非负整数。");
    this.toolCalls += count;
    if (this.toolCalls > this.limits.maxToolCalls) this.stop("tool-budget-exhausted", `工具调用已达到 ${this.limits.maxToolCalls} 次上限。`);
  }

  public recordRetry(stepId: string): void {
    this.assertActive();
    const retries = (this.retries.get(stepId) ?? 0) + 1;
    this.retries.set(stepId, retries);
    if (retries > this.limits.maxStepRetries) this.stop("retry-budget-exhausted", `步骤 ${stepId} 已达到 ${this.limits.maxStepRetries} 次重试上限。`);
  }

  public recordError(code: string, message: string): void {
    this.assertActive();
    const signature = `${code}:${message}`;
    if (signature === this.lastErrorSignature) this.stop("repeated-error", "检测到重复错误，任务已截停。");
    this.lastErrorSignature = signature;
  }

  public cancel(): never {
    return this.stop("task-cancelled", "用户已取消任务。");
  }

  public assertActive(): void {
    if (this.stopError) throw this.stopError;
    if (this.now() - this.startedAt >= this.limits.totalTimeoutMs) this.stop("task-timeout", "任务已达到 15 分钟总超时。");
  }

  public remainingMs(): number {
    this.assertActive();
    return Math.max(0, this.limits.totalTimeoutMs - (this.now() - this.startedAt));
  }

  public snapshot(): ExecutionBudgetSnapshot {
    return { modelTurns: this.modelTurns, toolCalls: this.toolCalls, elapsedMs: Math.max(0, this.now() - this.startedAt), stopped: this.stopError !== null, ...(this.stopError ? { stopCode: this.stopError.code } : {}) };
  }

  private stop(code: ExecutionStopCode, message: string): never {
    this.stopError ??= new ExecutionBudgetError(code, message);
    throw this.stopError;
  }
}
