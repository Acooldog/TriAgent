/** Decrypt provider selection policy.
 *
 * Moved from application/provider/ because this is infrastructure-level
 * routing logic — choosing which decrypt provider to use based on capability
 * availability. The Application layer should consume this via a Policy
 * interface if needed, but the concrete strategy lives here.
 */
export type DecryptProviderKind = "primary" | "fallback";

export interface DecryptProviderCandidate { kind: DecryptProviderKind; available: boolean; reason?: string; }

export function selectKugouProvider(candidates: DecryptProviderCandidate[]): DecryptProviderCandidate {
  const primary = candidates.find((candidate) => candidate.kind === "primary");
  if (primary?.available) return primary;
  if (primary && primary.reason && !isRecoverable(primary.reason)) return primary;
  return candidates.find((candidate) => candidate.kind === "fallback" && candidate.available) ?? primary ?? { kind: "primary", available: false, reason: "未配置解密能力。" };
}

function isRecoverable(reason: string): boolean { return /不支持|不可用|能力缺失|格式/.test(reason); }
