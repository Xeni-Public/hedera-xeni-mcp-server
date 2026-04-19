// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * mandateBudgetGuard — rejects `transfer_hbar_with_allowance` calls that
 * would exceed the remaining budget on the user's intent mandate.
 *
 * Stage: postParamsNormalizationHook (runs BEFORE tx construction).
 * Side effects: NONE.
 *
 * See docs/DESIGN.md §6.
 *
 * Inputs:
 *   - normalized params: { ownerAccountId (=user), spenderAccountId (=agent),
 *     destinationAccountId (=treasury), amountHbar }
 *   - intent mandate state from AgentService via context metadata:
 *     { mandateTotalHbar, mandateSpentHbar, intentId }
 *
 * Behavior:
 *   - remaining = mandateTotalHbar - mandateSpentHbar
 *   - amountHbar <= remaining → pass
 *   - amountHbar  > remaining → reject
 */

export interface MandateBudgetGuardInput {
  amountHbar: number;
  mandateTotalHbar: number;
  mandateSpentHbar: number;
  intentId: string;
  correlationId?: string;
}

export interface MandateBudgetGuardResult {
  passed: boolean;
  remainingHbar: number;
  reason?: string;
}

export function mandateBudgetGuard(input: MandateBudgetGuardInput): MandateBudgetGuardResult {
  // TODO: use tinybar integer math to avoid FP rounding issues
  // TODO: log budget state on pass + reject (with correlationId)
  // TODO: structured reject reason
  void input;
  throw new Error('mandateBudgetGuard: scaffold skeleton; implementation lands in next PR');
}
