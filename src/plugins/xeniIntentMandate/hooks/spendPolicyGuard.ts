// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * spendPolicyGuard — rejects `approve_hbar_allowance` calls that exceed
 * the user's configured spend-policy ceiling.
 *
 * Stage: postParamsNormalizationHook (runs BEFORE tx construction).
 * Side effects: NONE — pure reject/pass decision.
 *
 * See docs/DESIGN.md §6 (plugin surface) and §4 (refund allowance strategy).
 *
 * Inputs (via hook context):
 *   - normalized params: { ownerAccountId, spenderAccountId, amountHbar }
 *   - per-user spend-policy ceiling (from AgentService via context metadata)
 *
 * Behavior:
 *   - amountHbar <= policyCeiling → pass
 *   - amountHbar  > policyCeiling → reject with structured error including
 *     the requested amount + ceiling + intent_id for AgentService to relay
 *     to the user
 */

// TODO: import hook/Context types from '@hashgraph/hedera-agent-kit' after first install

export interface SpendPolicyGuardInput {
  amountHbar: number;
  policyCeilingHbar: number;
  intentId: string;
  correlationId?: string;
}

export interface SpendPolicyGuardResult {
  passed: boolean;
  reason?: string;
}

export function spendPolicyGuard(input: SpendPolicyGuardInput): SpendPolicyGuardResult {
  // Skeleton — implementation lands in next PR.
  // TODO: log attempted allowance + ceiling (with correlationId)
  // TODO: threshold comparison with floating-point safety (HBAR is 8-decimal; use tinybar)
  // TODO: structured reject with human-readable reason
  void input;
  throw new Error('spendPolicyGuard: scaffold skeleton; implementation lands in next PR');
}
