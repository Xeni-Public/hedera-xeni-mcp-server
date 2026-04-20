// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * Direct unit tests for the shared `hbar.ts` helpers.
 *
 * These helpers are also exercised through the guard hooks
 * (spendPolicyGuard, mandateBudgetGuard) but direct tests here pin the
 * contract: if we ever tweak helper internals, we won't have to untangle
 * which hook test actually exercises the changed behavior.
 *
 * Addresses Lead Buddy's PR #5 observation O1 — put a safety net under
 * the shared module before `treasuryAllowanceGuard` (PR #6) becomes
 * consumer #3.
 */

import { describe, expect, it } from 'vitest';
import {
  TINYBAR_PER_HBAR,
  fromTinybar,
  invalidNumberReason,
  toTinybar,
} from '../../src/plugins/xeniIntentMandate/hbar.js';

describe('hbar', () => {
  describe('TINYBAR_PER_HBAR', () => {
    it('is exactly 10^8', () => {
      expect(TINYBAR_PER_HBAR).toBe(100_000_000);
    });
  });

  describe('toTinybar', () => {
    it('converts 0 HBAR to 0n tinybar', () => {
      expect(toTinybar(0)).toBe(0n);
    });

    it('converts 1 HBAR to 100_000_000n tinybar', () => {
      expect(toTinybar(1)).toBe(100_000_000n);
    });

    it('converts 0.00000001 HBAR (1 tinybar) correctly', () => {
      expect(toTinybar(0.00000001)).toBe(1n);
    });

    it('converts 10 HBAR correctly', () => {
      expect(toTinybar(10)).toBe(1_000_000_000n);
    });

    it('locks FP safety: toTinybar(0.1 + 0.2) === 30_000_000n', () => {
      // 0.1 + 0.2 === 0.30000000000000004 in JS float. Math.round recovers
      // the integer tinybar value. This is the load-bearing invariant for
      // all guard hooks that compare HBAR via tinybar.
      expect(toTinybar(0.1 + 0.2)).toBe(30_000_000n);
    });

    it('converts large safe values without precision loss', () => {
      // 1M HBAR * 1e8 = 1e14, well inside Number.MAX_SAFE_INTEGER (~9e15).
      expect(toTinybar(1_000_000)).toBe(100_000_000_000_000n);
    });
  });

  describe('fromTinybar', () => {
    it('converts 0n tinybar to 0 HBAR', () => {
      expect(fromTinybar(0n)).toBe(0);
    });

    it('converts 100_000_000n tinybar to 1 HBAR', () => {
      expect(fromTinybar(100_000_000n)).toBe(1);
    });

    it('converts 1n tinybar (smallest unit) to 0.00000001 HBAR', () => {
      expect(fromTinybar(1n)).toBe(0.00000001);
    });

    it('round-trips toTinybar → fromTinybar for integer HBAR values', () => {
      for (const hbar of [0, 1, 10, 100, 1_000, 10_000, 1_000_000]) {
        expect(fromTinybar(toTinybar(hbar))).toBe(hbar);
      }
    });

    it('round-trips for FP-representative values (0.1 + 0.2 → 0.3)', () => {
      // Demonstrates the whole point of routing through tinybar space.
      expect(fromTinybar(toTinybar(0.1 + 0.2))).toBe(0.3);
    });
  });

  describe('invalidNumberReason', () => {
    it('returns null for a valid non-negative finite number', () => {
      expect(invalidNumberReason(0, 'x')).toBeNull();
      expect(invalidNumberReason(1, 'x')).toBeNull();
      expect(invalidNumberReason(1.5, 'x')).toBeNull();
      expect(invalidNumberReason(1e10, 'x')).toBeNull();
    });

    it('returns a reason for NaN, naming the field', () => {
      const reason = invalidNumberReason(NaN, 'amountHbar');
      expect(reason).toMatch(/finite/i);
      expect(reason).toContain('amountHbar');
    });

    it('returns a reason for +Infinity', () => {
      expect(invalidNumberReason(Infinity, 'x')).toMatch(/finite/i);
    });

    it('returns a reason for -Infinity', () => {
      expect(invalidNumberReason(-Infinity, 'x')).toMatch(/finite/i);
    });

    it('returns a reason for a negative number, naming the field', () => {
      const reason = invalidNumberReason(-5, 'ceilingHbar');
      expect(reason).toMatch(/negative/i);
      expect(reason).toContain('ceilingHbar');
    });

    it('treats -0 the same as 0 (accepted)', () => {
      expect(invalidNumberReason(-0, 'x')).toBeNull();
    });

    it('prioritizes finite check over negative check (finite fails first for NaN)', () => {
      // NaN is not > 0, not < 0, not === 0. The finite check must catch it first.
      const reason = invalidNumberReason(NaN, 'x');
      expect(reason).toMatch(/finite/i);
      expect(reason).not.toMatch(/negative/i);
    });
  });
});
