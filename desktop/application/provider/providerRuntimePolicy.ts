import { ProviderRuntimeError, type ProviderRuntimeApproval, type ProviderRuntimeApprovalRequest, type ProviderRuntimeStartRequest } from "./protocols/providerRuntimeProtocol";

export class ProviderRuntimeStartPolicy {
  public constructor(private readonly approval: ProviderRuntimeApproval) {}

  public async authorize(request: ProviderRuntimeStartRequest, displayName: string): Promise<void> {
    if (request.permissionMode === "restricted") {
      throw new ProviderRuntimeError("provider-runtime-restricted", "受限模式不允许启动 Provider。", "start");
    }
    if (request.permissionMode === "full") return;
    const approvalRequest: ProviderRuntimeApprovalRequest = {
      ...request,
      displayName,
      reason: "Provider 需要启动外部运行时才能提供所选能力。",
    };
    if (!await this.approval.requestStartApproval(approvalRequest)) {
      throw new ProviderRuntimeError("provider-runtime-approval-denied", "用户未批准启动 Provider。", "start");
    }
  }
}
