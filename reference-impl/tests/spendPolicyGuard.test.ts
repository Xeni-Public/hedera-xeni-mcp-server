// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * spendPolicyGuard unit tests.
 *
 * Covers:
 *   - accept path: amount < ceiling, amount === ceiling (inclusive), amount = 0
 *   - reject path: amount > ceiling, zero ceiling, negative values, NaN, Infinity, empty intentId
 *   - reject reason includes both amount and ceiling for downstream user messaging
 *   - tinybar-integer comparison avoids 0.1 + 0.2 ≠ 0.3 FP rounding
 *   - correlationId is optional passthrough, does not affect decision
 */

import { describe, expect, it } from 'vitest';
import { spendPolicyGuard } from '../hooks/spendPolicyGuard.js';

const baseInput = {
  amountHbar: 10,
  policyCeilingHbar: 100,
  intentId: 'intent-001',
};

describe('spendPolicyGuard', () => {
  describe('accepts', () => {
    it('passes when amount is below ceiling', () => {
      expect(spendPolicyGuard(baseInput).passed).toBe(true);
    });

    it('passes when amount equals ceiling (inclusive boundary)', () => {
      expect(
        spendPolicyGuard({ ...baseInput, amountHbar: 100, policyCeilingHbar: 100 }).passed,
      ).toBe(true);
    });

    it('passes when amount is zero', () => {
      expect(spendPolicyGuard({ ...baseInput, amountHbar: 0 }).passed).toBe(true);
    });

    it('omits reason field on pass', () => {
      expect(spendPolicyGuard(baseInput).reason).toBeUndefined();
    });

    it('passes with optional correlationId present', () => {
      expect(spendPolicyGuard({ ...baseInput, correlationId: 'corr-abc' }).passed).toBe(true);
    });
  });

  describe('rejects by ceiling', () => {
    it('rejects when amount exceeds ceiling by 1 HBAR', () => {
      const result = spendPolicyGuard({ ...baseInput, amountHbar: 101 });
      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/exceeds/i);
      // Assert the rejection surfaces both the requested amount and the ceiling,
      // with the HBAR unit suffix. Structured shape check rather than a bare
      // numeric regex (which would match substrings like 1001 or 1005 spuriously).
      expect(result.reason).toContain('101 HBAR');
      expect(result.reason).toContain('100 HBAR');
    });

    it('rejects when amount exceeds ceiling by 1 tinybar (8-decimal precision)', () => {
      // 1.00000001 HBAR > 1.0 HBAR at tinybar resolution — must reject.
      const result = spendPolicyGuard({
        ...baseInput,
        amountHbar: 1.00000001,
        policyCeilingHbar: 1,
      });
      expect(result.passed).toBe(false);
    });

    it('rejects when ceiling is zero and amount is positive', () => {
      const result = spendPolicyGuard({ ...baseInput, amountHbar: 0.0001, policyCeilingHbar: 0 });
      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/exceeds/i);
    });

    it('passes when both amount and ceiling are zero (degenerate but valid)', () => {
      const result = spendPolicyGuard({ ...baseInput, amountHbar: 0, policyCeilingHbar: 0 });
      expect(result.passed).toBe(true);
    });
  });

  describe('rejects by invalid input (fail-closed)', () => {
    it('rejects NaN amount', () => {
      const result = spendPolicyGuard({ ...baseInput, amountHbar: NaN });
      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/finite/i);
      expect(result.reason).toMatch(/amountHbar/);
    });

    it('rejects Infinity amount', () => {
      const result = spendPolicyGuard({ ...baseInput, amountHbar: Infinity });
      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/finite/i);
    });

    it('rejects -Infinity amount', () => {
      const result = spendPolicyGuard({ ...baseInput, amountHbar: -Infinity });
      expect(result.passed).toBe(false);
    });

    it('rejects negative amount', () => {
      const result = spendPolicyGuard({ ...baseInput, amountHbar: -1 });
      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/negative/i);
    });

    it('rejects NaN ceiling', () => {
      const result = spendPolicyGuard({ ...baseInput, policyCeilingHbar: NaN });
      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/policyCeilingHbar/);
    });

    it('rejects negative ceiling', () => {
      const result = spendPolicyGuard({ ...baseInput, policyCeilingHbar: -5 });
      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/negative/i);
    });

    it('rejects empty intentId', () => {
      const result = spendPolicyGuard({ ...baseInput, intentId: '' });
      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/intentId/);
    });
  });

  describe('floating-point safety (tinybar conversion)', () => {
    it('handles 0.1 + 0.2 === 0.3 correctly without false-rejecting', () => {
      // 0.1 + 0.2 evaluates to 0.30000000000000004 in JS floats.
      // Tinybar comparison via Math.round should normalize to 30_000_000 tb
      // and NOT treat this as exceeding a ceiling of 0.3 HBAR.
      const result = spendPolicyGuard({
        ...baseInput,
        amountHbar: 0.1 + 0.2,
        policyCeilingHbar: 0.3,
      });
      expect(result.passed).toBe(true);
    });

    it('handles very small HBAR amounts (1 tinybar) correctly', () => {
      // 0.00000001 HBAR = 1 tinybar. Under a 2-tinybar ceiling → pass.
      const result = spendPolicyGuard({
        ...baseInput,
        amountHbar: 0.00000001,
        policyCeilingHbar: 0.00000002,
      });
      expect(result.passed).toBe(true);
    });

    it('handles large HBAR amounts without precision loss (up to safe-arithmetic bound)', () => {
      // HBAR amount is a JS `number` (float64). `Math.round(hbar * 1e8)` is
      // exact only while `hbar * 1e8` fits within `Number.MAX_SAFE_INTEGER`
      // (~9e15), i.e. `hbar <= ~9e7` (~90M HBAR). v1 spend ceilings are
      // bounded far below this (refund cap is 10k HBAR/day; individual-user
      // ceilings lower still). `BigInt` handles the *comparison* of larger
      // integers but can't recover precision lost during the multiply.
      // 1M HBAR here is comfortably inside the safe range (1e6 * 1e8 = 1e14).
      const result = spendPolicyGuard({
        ...baseInput,
        amountHbar: 1_000_000,
        policyCeilingHbar: 2_000_000,
      });
      expect(result.passed).toBe(true);
    });
  });
});
