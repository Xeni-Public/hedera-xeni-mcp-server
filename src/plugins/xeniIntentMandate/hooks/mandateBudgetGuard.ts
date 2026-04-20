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

import { log } from '../../../logger.js';
import { fromTinybar, invalidNumberReason, toTinybar } from '../hbar.js';

export interface MandateBudgetGuardInput {
  /** Requested transfer amount in HBAR. */
  amountHbar: number;
  /** Total mandate budget approved for this intent, in HBAR. */
  mandateTotalHbar: number;
  /** Amount already spent against this mandate so far, in HBAR. */
  mandateSpentHbar: number;
  /** Intent ID for logging + reject-reason attribution. */
  intentId: string;
  /** Optional correlation ID threaded through from AgentService for tracing. */
  correlationId?: string;
}

export interface MandateBudgetGuardResult {
  passed: boolean;
  /**
   * Budget remaining before this transfer, in HBAR.
   * On invalid-input or invalid-mandate-state rejects, returned as 0
   * (the real "remaining" is meaningless in those cases — caller should
   * branch on `passed` first, not read `remainingHbar` unconditionally).
   * On budget-exceeded rejects and on pass, reflects the true remaining.
   */
  remainingHbar: number;
  /** Human-readable reason; populated on reject, omitted on pass. */
  reason?: string;
}

/**
 * Pure policy check. No side effects beyond a single log line (stderr).
 *
 * Decision rule: `amountTb > remainingTb` → reject. Strict greater-than
 * gives an inclusive boundary — a mandate with `remaining === amount`
 * (spending the final HBAR) passes. Consistent with `spendPolicyGuard`.
 *
 * Input validation: fail-closed on NaN / ±Infinity / negative for any
 * of the three numeric fields, and on empty `intentId`.
 *
 * Data integrity: also rejects when `spent > total`, which shouldn't
 * happen but would mean AgentService sent a corrupted mandate state.
 * Surfacing the upstream bug is more useful than silently passing.
 */
export function mandateBudgetGuard(input: MandateBudgetGuardInput): MandateBudgetGuardResult {
  const { amountHbar, mandateTotalHbar, mandateSpentHbar, intentId, correlationId } = input;

  // Input validation — fail-closed on any malformed value.
  const amountInvalid = invalidNumberReason(amountHbar, 'amountHbar');
  const totalInvalid = invalidNumberReason(mandateTotalHbar, 'mandateTotalHbar');
  const spentInvalid = invalidNumberReason(mandateSpentHbar, 'mandateSpentHbar');
  const invalid = amountInvalid ?? totalInvalid ?? spentInvalid;
  if (invalid) {
    const reason = `Invalid input to mandateBudgetGuard: ${invalid}.`;
    log.warn('mandateBudgetGuard rejected (invalid input)', {
      intentId,
      correlationId,
      amountHbar,
      mandateTotalHbar,
      mandateSpentHbar,
      reason,
    });
    return { passed: false, remainingHbar: 0, reason };
  }

  if (!intentId) {
    const reason = 'Invalid input to mandateBudgetGuard: intentId is required.';
    log.warn('mandateBudgetGuard rejected (invalid input)', { correlationId, reason });
    return { passed: false, remainingHbar: 0, reason };
  }

  const amountTb = toTinybar(amountHbar);
  const totalTb = toTinybar(mandateTotalHbar);
  const spentTb = toTinybar(mandateSpentHbar);

  // Data-integrity check: spent must not exceed total. If it does,
  // AgentService sent a corrupted mandate state — fail-closed so the
  // upstream bug surfaces instead of being masked.
  if (spentTb > totalTb) {
    const reason = `Invalid mandate state: spent (${mandateSpentHbar} HBAR) exceeds total (${mandateTotalHbar} HBAR).`;
    log.warn('mandateBudgetGuard rejected (invalid mandate state)', {
      intentId,
      correlationId,
      mandateTotalHbar,
      mandateSpentHbar,
    });
    return { passed: false, remainingHbar: 0, reason };
  }

  const remainingTb = totalTb - spentTb;
  const remainingHbar = fromTinybar(remainingTb);

  if (amountTb > remainingTb) {
    const reason = `Transfer (${amountHbar} HBAR) exceeds remaining mandate budget (${remainingHbar} HBAR).`;
    log.warn('mandateBudgetGuard rejected', {
      intentId,
      correlationId,
      amountHbar,
      mandateTotalHbar,
      mandateSpentHbar,
      remainingHbar,
    });
    return { passed: false, remainingHbar, reason };
  }

  log.debug('mandateBudgetGuard passed', {
    intentId,
    correlationId,
    amountHbar,
    remainingHbar,
  });
  return { passed: true, remainingHbar };
}
