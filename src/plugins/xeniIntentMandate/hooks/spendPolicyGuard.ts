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

// TODO: integrate with hook/Context types from '@hashgraph/hedera-agent-kit' when the
// plugin is wired into HederaMCPToolkit (tracked for the server.buildToolkit impl PR).

import { log } from '../../../logger.js';

export interface SpendPolicyGuardInput {
  /** Requested allowance amount in HBAR. */
  amountHbar: number;
  /** User's configured policy ceiling in HBAR (delivered via tool context metadata). */
  policyCeilingHbar: number;
  /** Intent ID for logging + reject-reason attribution. */
  intentId: string;
  /** Optional correlation ID threaded through from AgentService for tracing. */
  correlationId?: string;
}

export interface SpendPolicyGuardResult {
  passed: boolean;
  /** Human-readable reason; populated on reject, omitted on pass. */
  reason?: string;
}

/** 1 HBAR = 10^8 tinybar. Comparison is done in tinybar integer space to avoid FP rounding. */
const TINYBAR_PER_HBAR = 100_000_000;

function toTinybar(hbar: number): bigint {
  // Math.round recovers the integer after float multiplication
  // (e.g. (0.1 + 0.2) * 1e8 = 30000000.000000004 → 30000000).
  return BigInt(Math.round(hbar * TINYBAR_PER_HBAR));
}

function invalidNumberReason(value: number, name: string): string | null {
  if (!Number.isFinite(value)) return `${name} is not a finite number`;
  if (value < 0) return `${name} is negative`;
  return null;
}

/**
 * Pure policy check. No side effects beyond a single log line (stderr).
 *
 * Decision rule: `amountTb > ceilingTb` → reject. Strict greater-than, so
 * `amount === ceiling` passes (inclusive boundary — a user configuring a
 * ceiling of N HBAR should be allowed an allowance of exactly N HBAR).
 *
 * Input validation fails-closed: any NaN/Infinity/negative value → reject.
 * Callers should treat rejects as a "relay to user" signal, not a retry.
 */
export function spendPolicyGuard(input: SpendPolicyGuardInput): SpendPolicyGuardResult {
  const { amountHbar, policyCeilingHbar, intentId, correlationId } = input;

  // Input validation — fail-closed on any malformed value.
  const amountInvalid = invalidNumberReason(amountHbar, 'amountHbar');
  const ceilingInvalid = invalidNumberReason(policyCeilingHbar, 'policyCeilingHbar');
  const invalid = amountInvalid ?? ceilingInvalid;
  if (invalid) {
    const reason = `Invalid input to spendPolicyGuard: ${invalid}.`;
    log.warn('spendPolicyGuard rejected (invalid input)', {
      intentId,
      correlationId,
      amountHbar,
      policyCeilingHbar,
      reason,
    });
    return { passed: false, reason };
  }

  if (!intentId) {
    const reason = 'Invalid input to spendPolicyGuard: intentId is required.';
    log.warn('spendPolicyGuard rejected (invalid input)', { correlationId, reason });
    return { passed: false, reason };
  }

  const amountTb = toTinybar(amountHbar);
  const ceilingTb = toTinybar(policyCeilingHbar);

  if (amountTb > ceilingTb) {
    const reason = `Requested allowance (${amountHbar} HBAR) exceeds user's configured spend ceiling (${policyCeilingHbar} HBAR).`;
    log.warn('spendPolicyGuard rejected', {
      intentId,
      correlationId,
      amountHbar,
      policyCeilingHbar,
    });
    return { passed: false, reason };
  }

  log.debug('spendPolicyGuard passed', {
    intentId,
    correlationId,
    amountHbar,
    policyCeilingHbar,
  });
  return { passed: true };
}
