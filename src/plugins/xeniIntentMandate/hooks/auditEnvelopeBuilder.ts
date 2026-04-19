/**
 * auditEnvelopeBuilder — builds the HCS audit event payload from a successful
 * tool result. Runs at postCoreActionHook (only after coreAction succeeds).
 *
 * **DOES NOT submit to HCS.** The envelope is attached to the MCP response
 * and AgentService writes it to its outbox. The outbox worker eventually
 * calls submit_message with this payload.
 *
 * See docs/DESIGN.md §13 (audit durability / outbox pattern).
 *
 * Contract (canonical response shape — see DESIGN.md §16):
 *   Input:  successful tool receipt + context
 *   Output: { schema_version: 1, event_id, event, tx_timestamp,
 *             intent_id, customer_id, user, total, destination,
 *             split_accounting, booking_ref, txId,
 *             remaining_user_allowance? | treasury_allowance_remaining_after? }
 *
 * Invariants:
 *   - event_id is generated HERE (UUID v4) — not by AgentService
 *   - Null fields are OMITTED, not sent as null
 *   - schema_version is literal 1 for v1
 *   - The payload survives Mirror Node filter + HashScan deep-link use cases
 *   - P3 invariant: consumer deduplication is by event_id; HCS does not
 *     dedupe natively, so if the outbox worker's "done" UPDATE fails after
 *     a successful submit, retry produces a duplicate payload with the same
 *     event_id on the topic. Consumers MUST dedupe by event_id.
 */

import { randomUUID } from 'node:crypto';

import type { FeeBreakdown } from '../../../fees/FeeCalculator.js';

export type AuditEvent =
  | 'payment_executed'
  | 'refund_executed'
  | 'allowance_granted'
  | 'allowance_revoked'
  | 'intent_created';

export interface AuditEnvelopeBuilderInput {
  event: AuditEvent;
  txId: string;
  /** Consensus timestamp from receipt, UTC ISO 8601, ms precision. */
  txTimestamp: string;
  intentId: string;
  customerId: string | null;
  user: string;
  /** Total in HBAR. */
  total: number;
  destination: string;
  splitAccounting: FeeBreakdown;
  bookingRef: string;
  /** Payment events only. */
  remainingUserAllowance?: number;
  /** Refund events only. */
  treasuryAllowanceRemainingAfter?: number;
}

export interface AuditEnvelope {
  schema_version: 1;
  event_id: string;
  event: AuditEvent;
  tx_timestamp: string;
  intent_id: string;
  customer_id: string | null;
  user: string;
  total: number;
  destination: string;
  split_accounting: {
    supplier_cost: number;
    platform_fee: number;
    customer_commission: number;
  };
  booking_ref: string;
  txId: string;
  // Optional fields — omitted when not applicable per null-omission rule
  remaining_user_allowance?: number;
  treasury_allowance_remaining_after?: number;
}

/**
 * Pure function. No side effects. No HCS submit.
 */
export function auditEnvelopeBuilder(input: AuditEnvelopeBuilderInput): AuditEnvelope {
  const envelope: AuditEnvelope = {
    schema_version: 1,
    event_id: randomUUID(),
    event: input.event,
    tx_timestamp: input.txTimestamp,
    intent_id: input.intentId,
    customer_id: input.customerId,
    user: input.user,
    total: input.total,
    destination: input.destination,
    split_accounting: {
      supplier_cost: input.splitAccounting.supplierCost,
      platform_fee: input.splitAccounting.platformFee,
      customer_commission: input.splitAccounting.customerCommission,
    },
    booking_ref: input.bookingRef,
    txId: input.txId,
  };

  // Null-omission rule: only set if defined (per DESIGN.md §5)
  if (input.remainingUserAllowance !== undefined) {
    envelope.remaining_user_allowance = input.remainingUserAllowance;
  }
  if (input.treasuryAllowanceRemainingAfter !== undefined) {
    envelope.treasury_allowance_remaining_after = input.treasuryAllowanceRemainingAfter;
  }

  return envelope;
}
