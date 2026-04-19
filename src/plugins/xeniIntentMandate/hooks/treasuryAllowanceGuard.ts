// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * treasuryAllowanceGuard — rejects refund `transfer_hbar_with_allowance`
 * calls that would exceed the remaining treasury→agent daily allowance.
 * Also fires Slack alert at the 80% threshold.
 *
 * Stage: postParamsNormalizationHook (refund path only — detected by owner
 * role = 'xeni_treasury').
 * Side effects: Slack webhook call (alert only, not audit).
 *
 * See docs/DESIGN.md §4 (refund allowance strategy).
 *
 * Alert channels:
 *   #non-prod-oncall-fund-treasury (dev/qa/uat)
 *   #oncall-fund-treasury (prod)
 *   workspace: xeniworkspace.slack.com
 *
 * Source of truth for remaining allowance: Hedera Mirror Node (no local DB state).
 */

export interface TreasuryAllowanceGuardInput {
  amountHbar: number;
  intentId: string;
  correlationId?: string;
  /** For alert payload fiat context (computed at alert time). */
  fiatPerHbar?: number;
}

export interface TreasuryAllowanceGuardResult {
  passed: boolean;
  remainingAllowanceAfter: number;
  alertFired: boolean;
  reason?: string;
}

// eslint-disable-next-line @typescript-eslint/require-await -- skeleton; await lands when Mirror Node query + Slack webhook call are wired (see TODO list below).
export async function treasuryAllowanceGuard(
  input: TreasuryAllowanceGuardInput,
): Promise<TreasuryAllowanceGuardResult> {
  // TODO: query Mirror Node for current treasury→agent remaining allowance
  // TODO: compute remainingAfter = remaining - amountHbar
  // TODO: if remainingAfter < 0 → reject with structured reason
  // TODO: if remainingAfter crosses 80% threshold → fire Slack alert
  // TODO: alert payload includes: remaining HBAR, fiat equiv, daily cap,
  //   env label, UTC+PST timestamps, runbook link (docs/RUNBOOKS.md#treasury-replenishment)
  // TODO: alert sending is fire-and-forget (don't block the tool call on Slack)
  void input;
  throw new Error('treasuryAllowanceGuard: scaffold skeleton; implementation lands in next PR');
}
