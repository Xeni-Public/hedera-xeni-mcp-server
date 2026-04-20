// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * auditEnvelopeBuilder unit tests — the only hook with real logic landed in
 * scaffold PR. Other hooks + policies are skeleton stubs; their tests land in
 * implementation PRs.
 *
 * Covers:
 *   - Canonical envelope shape per DESIGN.md §5 + §16
 *   - schema_version literal = 1
 *   - event_id generated as UUID v4 (unique per call)
 *   - Null-omission rule: optional fields omitted, not sent as null
 *   - Deterministic split_accounting mapping (snake_case output)
 */

import { describe, expect, it } from 'vitest';
import { auditEnvelopeBuilder } from '../hooks/auditEnvelopeBuilder.js';

const baseInput = {
  event: 'payment_executed' as const,
  txId: '0.0.8641977@1745612345.123456789',
  txTimestamp: '2026-04-18T22:15:03Z',
  intentId: 'intent-001',
  customerId: 'acme-travel',
  user: '0.0.9999999',
  total: 10.0,
  destination: 'xeni_treasury',
  splitAccounting: { supplierCost: 8.0, platformFee: 1.0, customerCommission: 1.0 },
  bookingRef: 'BOOK-001',
};

describe('auditEnvelopeBuilder', () => {
  it('produces schema_version literal 1', () => {
    const env = auditEnvelopeBuilder(baseInput);
    expect(env.schema_version).toBe(1);
  });

  it('generates a UUID v4 event_id', () => {
    const env = auditEnvelopeBuilder(baseInput);
    // UUID v4 regex: 8-4-4-Y-12 where Y starts with 4 (version) and next starts with 8-b (variant)
    expect(env.event_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('generates a distinct event_id per call', () => {
    const a = auditEnvelopeBuilder(baseInput);
    const b = auditEnvelopeBuilder(baseInput);
    expect(a.event_id).not.toBe(b.event_id);
  });

  it('maps splitAccounting camelCase → snake_case in output', () => {
    const env = auditEnvelopeBuilder(baseInput);
    expect(env.split_accounting).toEqual({
      supplier_cost: 8.0,
      platform_fee: 1.0,
      customer_commission: 1.0,
    });
  });

  it('omits remaining_user_allowance when not set (null-omission rule)', () => {
    const env = auditEnvelopeBuilder(baseInput);
    expect(env).not.toHaveProperty('remaining_user_allowance');
  });

  it('omits treasury_allowance_remaining_after when not set', () => {
    const env = auditEnvelopeBuilder(baseInput);
    expect(env).not.toHaveProperty('treasury_allowance_remaining_after');
  });

  it('includes remaining_user_allowance for payment events when provided', () => {
    const env = auditEnvelopeBuilder({ ...baseInput, remainingUserAllowance: 90.0 });
    expect(env.remaining_user_allowance).toBe(90.0);
  });

  it('includes treasury_allowance_remaining_after for refund events when provided', () => {
    const env = auditEnvelopeBuilder({
      ...baseInput,
      event: 'refund_executed',
      treasuryAllowanceRemainingAfter: 9500.0,
    });
    expect(env.treasury_allowance_remaining_after).toBe(9500.0);
  });

  it('carries through txId unchanged (matches receipt.txId per DESIGN §16)', () => {
    const env = auditEnvelopeBuilder(baseInput);
    expect(env.txId).toBe(baseInput.txId);
  });

  it('passes through tx_timestamp unchanged (UTC ISO 8601)', () => {
    const env = auditEnvelopeBuilder(baseInput);
    expect(env.tx_timestamp).toBe(baseInput.txTimestamp);
  });
});
