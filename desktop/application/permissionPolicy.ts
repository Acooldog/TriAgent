import type { PermissionMode, SensitiveOperation } from "./toolProtocol";

export interface PermissionRequest {
  mode: PermissionMode;
  operation: SensitiveOperation;
  title: string;
  detail: string;
  networkEnabled?: boolean;
}

export interface SensitiveOperationApproval {
  requestApproval(request: PermissionRequest): Promise<boolean>;
}

export class PermissionPolicyError extends Error {
  public constructor(public readonly code: "permission-denied" | "approval-denied" | "network-disabled", message: string) {
    super(message);
    this.name = "PermissionPolicyError";
  }
}

export class PermissionPolicy {
  public constructor(private readonly approval: SensitiveOperationApproval) {}

  public async authorize(request: PermissionRequest): Promise<void> {
    if (request.operation === "network" && request.networkEnabled !== true) {
      throw new PermissionPolicyError("network-disabled", "联网默认关闭，请先在当前会话中启用联网。");
    }
    if (request.operation === "built-in") return;
    if (request.mode === "restricted") {
      throw new PermissionPolicyError("permission-denied", "受限模式不允许执行此敏感操作。");
    }
    if (request.mode === "full") return;
    if (!await this.approval.requestApproval(request)) {
      throw new PermissionPolicyError("approval-denied", "用户未批准此敏感操作。");
    }
  }
}
