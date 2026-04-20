// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * mandateBudgetGuard unit tests.
 *
 * Covers:
 *   - accept path: amount < remaining, amount === remaining (inclusive), amount = 0
 *   - reject by budget: amount > remaining (by 1 HBAR and by 1 tinybar), zero remaining + positive amount
 *   - reject by invalid mandate state: spent > total (upstream-bug detection)
 *   - reject by invalid input: NaN / ±Infinity / negative on any of the 3 numeric fields, empty intentId
 *   - reject reasons surface the requested amount and the remaining budget with HBAR unit suffix
 *   - remainingHbar semantics: actual value on budget-reject and on pass, 0 on invalid-input / invalid-state
 *   - tinybar-integer comparison avoids 0.1 + 0.2 ≠ 0.3 FP rounding
 *   - correlationId is optional passthrough, does not affect decision
 */

import { describe, expect, it } from 'vitest';
import { mandateBudgetGuard } from '../hooks/mandateBudgetGuard.js';

const baseInput = {
  amountHbar: 10,
  mandateTotalHbar: 100,
  mandateSpentHbar: 30,
  intentId: 'intent-001',
};
// remaining = 100 - 30 = 70 HBAR

describe('mandateBudgetGuard', () => {
  describe('accepts', () => {
    it('passes when amount is below remaining', () => {
      const result = mandateBudgetGuard(baseInput);
      expect(result.passed).toBe(true);
      expect(result.remainingHbar).toBe(70);
      expect(result.reason).toBeUndefined();
    });

    it('passes when amount equals remaining (inclusive boundary — final-HBAR spend)', () => {
      const result = mandateBudgetGuard({ ...baseInput, amountHbar: 70 });
      expect(result.passed).toBe(true);
      expect(result.remainingHbar).toBe(70);
    });

    it('passes when amount is zero', () => {
      const result = mandateBudgetGuard({ ...baseInput, amountHbar: 0 });
      expect(result.passed).toBe(true);
      expect(result.remainingHbar).toBe(70);
    });

    it('passes when total and spent are both zero (no budget, no spend)', () => {
      const result = mandateBudgetGuard({
        ...baseInput,
        amountHbar: 0,
        mandateTotalHbar: 0,
        mandateSpentHbar: 0,
      });
      expect(result.passed).toBe(true);
      expect(result.remainingHbar).toBe(0);
    });

    it('passes when mandate is fully spent and amount is zero (degenerate but valid)', () => {
      // total=100, spent=100, amount=0 → remaining=0, no-op transfer.
      // Addresses Lead Buddy PR #5 observation O2 — locks the degenerate
      // edge explicitly (previously only covered implicitly via `0 > 0`).
      const result = mandateBudgetGuard({
        ...baseInput,
        mandateTotalHbar: 100,
        mandateSpentHbar: 100,
        amountHbar: 0,
      });
      expect(result.passed).toBe(true);
      expect(result.remainingHbar).toBe(0);
    });

    it('passes with optional correlationId present', () => {
      expect(mandateBudgetGuard({ ...baseInput, correlationId: 'corr-abc' }).passed).toBe(true);
    });

    it('returns the correct remainingHbar on pass (total − spent)', () => {
      const result = mandateBudgetGuard({
        ...baseInput,
        mandateTotalHbar: 500,
        mandateSpentHbar: 123.4,
        amountHbar: 1,
      });
      expect(result.passed).toBe(true);
      expect(result.remainingHbar).toBeCloseTo(500 - 123.4, 8);
    });
  });

  describe('rejects by budget', () => {
    it('rejects when amount exceeds remaining by 1 HBAR', () => {
      const result = mandateBudgetGuard({ ...baseInput, amountHbar: 71 });
      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/exceeds/i);
      // Structured reject: both requested amount and remaining budget with HBAR suffix.
      expect(result.reason).toContain('71 HBAR');
      expect(result.reason).toContain('70 HBAR');
      // Remaining should still reflect the true value (caller may surface it).
      expect(result.remainingHbar).toBe(70);
    });

    it('rejects when amount exceeds remaining by 1 tinybar (8-decimal precision)', () => {
      // remaining = 1 HBAR; amount = 1.00000001 HBAR → reject at tinybar resolution.
      const result = mandateBudgetGuard({
        ...baseInput,
        mandateTotalHbar: 1,
        mandateSpentHbar: 0,
        amountHbar: 1.00000001,
      });
      expect(result.passed).toBe(false);
    });

    it('rejects when remaining is zero and amount is positive', () => {
      const result = mandateBudgetGuard({
        ...baseInput,
        mandateTotalHbar: 50,
        mandateSpentHbar: 50,
        amountHbar: 0.0001,
      });
      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/exceeds/i);
      expect(result.remainingHbar).toBe(0);
    });
  });

  describe('rejects by invalid mandate state (data-integrity)', () => {
    it('rejects when spent exceeds total (corrupted mandate — surfaces upstream bug)', () => {
      const result = mandateBudgetGuard({
        ...baseInput,
        mandateTotalHbar: 100,
        mandateSpentHbar: 150,
      });
      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/invalid mandate state/i);
      expect(result.reason).toContain('150 HBAR');
      expect(result.reason).toContain('100 HBAR');
      // Invalid-state rejects return 0 — caller shouldn't trust remainingHbar here.
      expect(result.remainingHbar).toBe(0);
    });
  });

  describe('rejects by invalid input (fail-closed)', () => {
    it('rejects NaN amount', () => {
      const result = mandateBudgetGuard({ ...baseInput, amountHbar: NaN });
      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/finite/i);
      expect(result.reason).toMatch(/amountHbar/);
      expect(result.remainingHbar).toBe(0);
    });

    it('rejects Infinity amount', () => {
      const result = mandateBudgetGuard({ ...baseInput, amountHbar: Infinity });
      expect(result.passed).toBe(false);
    });

    it('rejects negative amount', () => {
      const result = mandateBudgetGuard({ ...baseInput, amountHbar: -1 });
      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/negative/i);
    });

    it('rejects NaN mandateTotalHbar', () => {
      const result = mandateBudgetGuard({ ...baseInput, mandateTotalHbar: NaN });
      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/mandateTotalHbar/);
    });

    it('rejects negative mandateTotalHbar', () => {
      const result = mandateBudgetGuard({ ...baseInput, mandateTotalHbar: -10 });
      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/negative/i);
    });

    it('rejects NaN mandateSpentHbar', () => {
      const result = mandateBudgetGuard({ ...baseInput, mandateSpentHbar: NaN });
      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/mandateSpentHbar/);
    });

    it('rejects negative mandateSpentHbar', () => {
      const result = mandateBudgetGuard({ ...baseInput, mandateSpentHbar: -5 });
      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/negative/i);
    });

    it('rejects empty intentId', () => {
      const result = mandateBudgetGuard({ ...baseInput, intentId: '' });
      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/intentId/);
    });
  });

  describe('floating-point safety (tinybar conversion)', () => {
    it('handles remainingHbar computed from 0.1 + 0.2 without false-rejecting', () => {
      // total = 0.3, spent = 0, amount = 0.3 (represented as 0.1 + 0.2 in float).
      // Without tinybar normalization, amount > remaining would spuriously reject.
      const result = mandateBudgetGuard({
        ...baseInput,
        mandateTotalHbar: 0.3,
        mandateSpentHbar: 0,
        amountHbar: 0.1 + 0.2,
      });
      expect(result.passed).toBe(true);
    });

    it('handles 1-tinybar remaining correctly', () => {
      // 0.00000002 total − 0.00000001 spent = 0.00000001 remaining = 1 tinybar.
      // Amount of 1 tinybar → pass (inclusive).
      const result = mandateBudgetGuard({
        ...baseInput,
        mandateTotalHbar: 0.00000002,
        mandateSpentHbar: 0.00000001,
        amountHbar: 0.00000001,
      });
      expect(result.passed).toBe(true);
      expect(result.remainingHbar).toBeCloseTo(0.00000001, 8);
    });
  });
});
