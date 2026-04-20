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

import { log } from '../logger.js';
import { fromTinybar, invalidNumberReason, toTinybar } from '../hbar.js';

export interface TreasuryAllowanceGuardInput {
  /** Requested refund amount in HBAR. */
  amountHbar: number;
  /** Intent ID for logging + reject-reason attribution. */
  intentId: string;
  /** Optional correlation ID threaded through from AgentService for tracing. */
  correlationId?: string;
  /** Optional fiat/HBAR price for Slack alert context (USD per HBAR). */
  fiatPerHbar?: number;
}

export interface SlackAlertPayload {
  envLabel: string;
  remainingHbar: number;
  dailyCapHbar: number;
  fiatEquivalent: number | null;
  fiatPerHbar: number | null;
  /** UTC ISO 8601. Source of truth timestamp. */
  timestampUtc: string;
  /** Human-readable PST for ops channel (per team channel + timezone conventions). */
  timestampPst: string;
  runbookRef: string;
}

export interface TreasuryAllowanceGuardDeps {
  /**
   * Query Hedera Mirror Node for the current remaining treasury→agent
   * allowance in HBAR. Network call — returns a Promise.
   *
   * Injected so tests can supply mocks. Runtime wiring (PR #7) supplies
   * the real Mirror Node REST client.
   */
  queryRemainingAllowanceHbar: () => Promise<number>;

  /**
   * Fire-and-forget Slack webhook sender. The hook does NOT block on
   * this Promise resolving — `.catch` is attached to log failures.
   */
  sendSlackAlert: (payload: SlackAlertPayload) => Promise<void>;

  /** Daily cap in HBAR (from HEDERA_REFUND_DAILY_CAP_HBAR env). */
  dailyCapHbar: number;

  /**
   * Alert threshold as fraction CONSUMED (0.8 = alert when 80% used / 20% remaining).
   * Alert fires on the refund that causes `remaining` to drop below
   * `dailyCap * (1 - thresholdFraction)`.
   */
  thresholdFraction: number;

  /** Environment label for alert context ('dev' / 'testnet-uat' / 'mainnet-prod'). */
  envLabel: string;
}

export interface TreasuryAllowanceGuardResult {
  passed: boolean;
  /**
   * Allowance remaining after this transfer (on pass).
   * On reject-by-allowance (amount > current), the pre-refund remaining.
   * On reject-by-invalid-input or Mirror-Node-error, 0 (meaningless; caller
   * should branch on `passed` first).
   */
  remainingAllowanceAfter: number;
  /** Whether a Slack alert was fired as a side effect of this call. */
  alertFired: boolean;
  /** Human-readable reason; populated on reject, omitted on pass. */
  reason?: string;
}

const RUNBOOK_REF = 'docs/RUNBOOKS.md#treasury-replenishment';
const PST_TIMEZONE = 'America/Los_Angeles';

/**
 * Hook with real side effects (Slack webhook) and real async I/O
 * (Mirror Node query). See docs/DESIGN.md §4 (refund allowance strategy).
 *
 * Decision flow:
 *   1. Input validation (NaN/Infinity/negative amount, empty intentId).
 *   2. Query Mirror Node for current treasury→agent remaining allowance.
 *      Fail-closed on query error or invalid response — refunds block
 *      rather than risk silent overspend.
 *   3. Reject if amount > current remaining (treasury needs top-up).
 *   4. Compute remainingAfter; if this refund crosses the alert threshold
 *      (remainingBefore >= threshold && remainingAfter < threshold),
 *      fire Slack alert fire-and-forget.
 *   5. Pass.
 *
 * The `thresholdFraction` convention mirrors `HEDERA_REFUND_ALERT_THRESHOLD`:
 * 0.8 means "alert at 80% consumed". Alert fires only on the *crossing*
 * refund, not every refund once below threshold — avoids spam.
 */
export async function treasuryAllowanceGuard(
  input: TreasuryAllowanceGuardInput,
  deps: TreasuryAllowanceGuardDeps,
): Promise<TreasuryAllowanceGuardResult> {
  const { amountHbar, intentId, correlationId, fiatPerHbar } = input;
  const { queryRemainingAllowanceHbar, sendSlackAlert, dailyCapHbar, thresholdFraction, envLabel } =
    deps;

  // --- 1. Input validation (fail-closed) ---
  const amountInvalid = invalidNumberReason(amountHbar, 'amountHbar');
  if (amountInvalid) {
    const reason = `Invalid input to treasuryAllowanceGuard: ${amountInvalid}.`;
    log.warn('treasuryAllowanceGuard rejected (invalid input)', {
      intentId,
      correlationId,
      amountHbar,
      reason,
    });
    return { passed: false, remainingAllowanceAfter: 0, alertFired: false, reason };
  }

  if (!intentId) {
    const reason = 'Invalid input to treasuryAllowanceGuard: intentId is required.';
    log.warn('treasuryAllowanceGuard rejected (invalid input)', { correlationId, reason });
    return { passed: false, remainingAllowanceAfter: 0, alertFired: false, reason };
  }

  // --- 2. Query Mirror Node for current remaining allowance ---
  let currentRemainingHbar: number;
  try {
    currentRemainingHbar = await queryRemainingAllowanceHbar();
  } catch (err) {
    const reason = `Unable to verify treasury allowance (Mirror Node query failed): ${String(err)}`;
    log.error('treasuryAllowanceGuard rejected (Mirror Node error)', {
      intentId,
      correlationId,
      error: String(err),
    });
    return { passed: false, remainingAllowanceAfter: 0, alertFired: false, reason };
  }

  const currentInvalid = invalidNumberReason(currentRemainingHbar, 'currentRemainingHbar');
  if (currentInvalid) {
    const reason = `Mirror Node returned invalid allowance: ${currentInvalid}.`;
    log.error('treasuryAllowanceGuard rejected (invalid Mirror Node response)', {
      intentId,
      correlationId,
      currentRemainingHbar,
      reason,
    });
    return { passed: false, remainingAllowanceAfter: 0, alertFired: false, reason };
  }

  // --- 3. Compare in tinybar space ---
  const amountTb = toTinybar(amountHbar);
  const currentTb = toTinybar(currentRemainingHbar);

  if (amountTb > currentTb) {
    const reason = `Refund (${amountHbar} HBAR) exceeds remaining treasury→agent allowance (${currentRemainingHbar} HBAR). Treasury needs top-up — see ${RUNBOOK_REF}.`;
    log.warn('treasuryAllowanceGuard rejected', {
      intentId,
      correlationId,
      amountHbar,
      currentRemainingHbar,
    });
    // Return the pre-refund remaining — useful for the caller to surface
    // "you have X HBAR left, requested Y" without a re-query.
    return {
      passed: false,
      remainingAllowanceAfter: currentRemainingHbar,
      alertFired: false,
      reason,
    };
  }

  // --- 4. Threshold-crossing alert detection ---
  const remainingAfterTb = currentTb - amountTb;
  const remainingAfterHbar = fromTinybar(remainingAfterTb);
  const alertBelowHbar = dailyCapHbar * (1 - thresholdFraction);

  const crossedThreshold =
    currentRemainingHbar >= alertBelowHbar && remainingAfterHbar < alertBelowHbar;

  let alertFired = false;
  if (crossedThreshold) {
    const now = new Date();
    const payload: SlackAlertPayload = {
      envLabel,
      remainingHbar: remainingAfterHbar,
      dailyCapHbar,
      fiatEquivalent: fiatPerHbar !== undefined ? remainingAfterHbar * fiatPerHbar : null,
      fiatPerHbar: fiatPerHbar !== undefined ? fiatPerHbar : null,
      timestampUtc: now.toISOString(),
      timestampPst: now.toLocaleString('en-US', { timeZone: PST_TIMEZONE, timeZoneName: 'short' }),
      runbookRef: RUNBOOK_REF,
    };

    // Fire-and-forget: don't block the hook's return on Slack network I/O.
    // Slack failures log but don't affect the refund decision.
    void sendSlackAlert(payload).catch((err: unknown) => {
      log.error('treasuryAllowanceGuard Slack alert failed (non-blocking)', {
        intentId,
        correlationId,
        error: String(err),
      });
    });
    alertFired = true;

    log.warn('treasuryAllowanceGuard threshold crossed (alert fired)', {
      intentId,
      correlationId,
      remainingAfterHbar,
      alertBelowHbar,
      dailyCapHbar,
    });
  }

  log.debug('treasuryAllowanceGuard passed', {
    intentId,
    correlationId,
    amountHbar,
    remainingAfterHbar,
    alertFired,
  });
  return { passed: true, remainingAllowanceAfter: remainingAfterHbar, alertFired };
}
