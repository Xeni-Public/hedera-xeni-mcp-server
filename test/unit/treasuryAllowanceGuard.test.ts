// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * treasuryAllowanceGuard unit tests.
 *
 * Unlike spendPolicyGuard/mandateBudgetGuard (pure), this hook has real
 * async I/O (Mirror Node query) and real side effects (Slack webhook).
 * Dependencies are injected via a `deps` object so tests can supply
 * mocks without touching network.
 *
 * Covers:
 *   - accept (below remaining, at remaining, zero amount)
 *   - reject: amount exceeds current remaining (treasury top-up needed)
 *   - reject: invalid input (NaN / Infinity / negative / empty intentId)
 *   - reject: Mirror Node query throws → fail-closed
 *   - reject: Mirror Node returns invalid number → fail-closed
 *   - alert fires when this refund causes remaining to cross below threshold
 *   - alert does NOT fire when already below threshold (no spam)
 *   - alert does NOT fire when amount keeps remaining at/above threshold
 *   - Slack send is fire-and-forget (hook returns before Slack resolves)
 *   - Slack send failure does NOT turn pass into reject (logged only)
 *   - alert payload shape: envLabel, remainingHbar, cap, fiat, UTC+PST timestamps, runbook ref
 *   - fiat equiv computed when fiatPerHbar provided; null when absent
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  SlackAlertPayload,
  TreasuryAllowanceGuardDeps,
  TreasuryAllowanceGuardInput,
} from '../../src/plugins/xeniIntentMandate/hooks/treasuryAllowanceGuard.js';
import { treasuryAllowanceGuard } from '../../src/plugins/xeniIntentMandate/hooks/treasuryAllowanceGuard.js';

/** Build a deps object with sensible defaults. Override per-test as needed. */
function makeDeps(overrides: Partial<TreasuryAllowanceGuardDeps> = {}): TreasuryAllowanceGuardDeps {
  return {
    queryRemainingAllowanceHbar: vi.fn(() => Promise.resolve(10_000)),
    sendSlackAlert: vi.fn(() => Promise.resolve()),
    dailyCapHbar: 10_000,
    thresholdFraction: 0.8, // alert at 80% consumed → below 2000 HBAR remaining
    envLabel: 'testnet-ci',
    ...overrides,
  };
}

const baseInput: TreasuryAllowanceGuardInput = {
  amountHbar: 10,
  intentId: 'intent-001',
};

describe('treasuryAllowanceGuard', () => {
  describe('accepts', () => {
    it('passes when amount is below current remaining', async () => {
      const deps = makeDeps({ queryRemainingAllowanceHbar: () => Promise.resolve(5_000) });
      const result = await treasuryAllowanceGuard(baseInput, deps);
      expect(result.passed).toBe(true);
      expect(result.remainingAllowanceAfter).toBe(4_990);
      expect(result.alertFired).toBe(false);
      expect(result.reason).toBeUndefined();
    });

    it('passes when amount equals current remaining (inclusive — final HBAR drain)', async () => {
      const deps = makeDeps({ queryRemainingAllowanceHbar: () => Promise.resolve(10) });
      const result = await treasuryAllowanceGuard(baseInput, deps);
      expect(result.passed).toBe(true);
      expect(result.remainingAllowanceAfter).toBe(0);
    });

    it('passes for amount = 0 (no-op)', async () => {
      const deps = makeDeps();
      const result = await treasuryAllowanceGuard({ ...baseInput, amountHbar: 0 }, deps);
      expect(result.passed).toBe(true);
    });
  });

  describe('rejects by allowance', () => {
    it('rejects when amount exceeds current remaining', async () => {
      const deps = makeDeps({ queryRemainingAllowanceHbar: () => Promise.resolve(5) });
      const result = await treasuryAllowanceGuard({ ...baseInput, amountHbar: 10 }, deps);
      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/exceeds remaining/i);
      expect(result.reason).toContain('10 HBAR');
      expect(result.reason).toContain('5 HBAR');
      expect(result.reason).toContain('top-up');
      expect(result.reason).toContain('RUNBOOKS.md');
      // Returns pre-refund remaining for caller to surface
      expect(result.remainingAllowanceAfter).toBe(5);
      expect(result.alertFired).toBe(false);
    });

    it('does not fire Slack alert on allowance reject (would spam as treasury already low)', async () => {
      const sendSlackAlert = vi.fn(() => Promise.resolve());
      const deps = makeDeps({
        queryRemainingAllowanceHbar: () => Promise.resolve(5),
        sendSlackAlert,
      });
      await treasuryAllowanceGuard({ ...baseInput, amountHbar: 10 }, deps);
      expect(sendSlackAlert).not.toHaveBeenCalled();
    });
  });

  describe('rejects by invalid input (fail-closed)', () => {
    it('rejects NaN amount', async () => {
      const result = await treasuryAllowanceGuard({ ...baseInput, amountHbar: NaN }, makeDeps());
      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/finite/i);
    });

    it('rejects Infinity amount', async () => {
      const result = await treasuryAllowanceGuard(
        { ...baseInput, amountHbar: Infinity },
        makeDeps(),
      );
      expect(result.passed).toBe(false);
    });

    it('rejects negative amount', async () => {
      const result = await treasuryAllowanceGuard({ ...baseInput, amountHbar: -1 }, makeDeps());
      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/negative/i);
    });

    it('rejects empty intentId', async () => {
      const result = await treasuryAllowanceGuard({ ...baseInput, intentId: '' }, makeDeps());
      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/intentId/);
    });

    it('does not call Mirror Node on invalid-input rejection', async () => {
      const queryRemainingAllowanceHbar = vi.fn(() => Promise.resolve(10_000));
      const deps = makeDeps({ queryRemainingAllowanceHbar });
      await treasuryAllowanceGuard({ ...baseInput, amountHbar: NaN }, deps);
      expect(queryRemainingAllowanceHbar).not.toHaveBeenCalled();
    });
  });

  describe('rejects by Mirror Node failure (fail-closed)', () => {
    it('rejects when Mirror Node query throws', async () => {
      const deps = makeDeps({
        queryRemainingAllowanceHbar: () => Promise.reject(new Error('network timeout')),
      });
      const result = await treasuryAllowanceGuard(baseInput, deps);
      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/Mirror Node query failed/);
      expect(result.reason).toContain('network timeout');
      expect(result.remainingAllowanceAfter).toBe(0);
    });

    it('rejects when Mirror Node returns NaN', async () => {
      const deps = makeDeps({ queryRemainingAllowanceHbar: () => Promise.resolve(NaN) });
      const result = await treasuryAllowanceGuard(baseInput, deps);
      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/Mirror Node returned invalid/);
    });

    it('rejects when Mirror Node returns a negative number', async () => {
      const deps = makeDeps({ queryRemainingAllowanceHbar: () => Promise.resolve(-1) });
      const result = await treasuryAllowanceGuard(baseInput, deps);
      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/negative/i);
    });
  });

  describe('threshold-crossing alert', () => {
    it('fires alert when refund causes remaining to drop below threshold', async () => {
      // dailyCap=10_000, threshold=0.8 → alert when remaining < 2_000.
      // Pre-refund remaining = 2_500 (above). Amount = 600 → after = 1_900 (below).
      const sendSlackAlert = vi.fn(() => Promise.resolve());
      const deps = makeDeps({
        queryRemainingAllowanceHbar: () => Promise.resolve(2_500),
        sendSlackAlert,
      });
      const result = await treasuryAllowanceGuard({ ...baseInput, amountHbar: 600 }, deps);

      expect(result.passed).toBe(true);
      expect(result.alertFired).toBe(true);
      expect(sendSlackAlert).toHaveBeenCalledOnce();

      const payload = sendSlackAlert.mock.calls[0]?.[0] as SlackAlertPayload;
      expect(payload.envLabel).toBe('testnet-ci');
      expect(payload.remainingHbar).toBeCloseTo(1_900, 6);
      expect(payload.dailyCapHbar).toBe(10_000);
      expect(payload.fiatEquivalent).toBeNull();
      expect(payload.fiatPerHbar).toBeNull();
      expect(payload.timestampUtc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(payload.timestampPst).toBeTruthy();
      expect(payload.runbookRef).toContain('RUNBOOKS.md');
    });

    it('does NOT fire alert when already below threshold before this refund', async () => {
      // Already below: remaining was 1_500 (below 2_000 threshold), amount = 100
      // → after = 1_400 (still below). Should not spam a second alert.
      const sendSlackAlert = vi.fn(() => Promise.resolve());
      const deps = makeDeps({
        queryRemainingAllowanceHbar: () => Promise.resolve(1_500),
        sendSlackAlert,
      });
      const result = await treasuryAllowanceGuard({ ...baseInput, amountHbar: 100 }, deps);

      expect(result.passed).toBe(true);
      expect(result.alertFired).toBe(false);
      expect(sendSlackAlert).not.toHaveBeenCalled();
    });

    it('does NOT fire alert when remaining stays at/above threshold after refund', async () => {
      // remaining 5_000, amount 10 → after 4_990, still above 2_000 threshold.
      const sendSlackAlert = vi.fn(() => Promise.resolve());
      const deps = makeDeps({
        queryRemainingAllowanceHbar: () => Promise.resolve(5_000),
        sendSlackAlert,
      });
      const result = await treasuryAllowanceGuard(baseInput, deps);

      expect(result.passed).toBe(true);
      expect(result.alertFired).toBe(false);
      expect(sendSlackAlert).not.toHaveBeenCalled();
    });

    it('includes fiat equivalent in alert payload when fiatPerHbar provided', async () => {
      const sendSlackAlert = vi.fn(() => Promise.resolve());
      const deps = makeDeps({
        queryRemainingAllowanceHbar: () => Promise.resolve(2_500),
        sendSlackAlert,
      });
      await treasuryAllowanceGuard({ ...baseInput, amountHbar: 600, fiatPerHbar: 0.2 }, deps);

      const payload = sendSlackAlert.mock.calls[0]?.[0] as SlackAlertPayload;
      expect(payload.fiatPerHbar).toBe(0.2);
      // 1_900 HBAR * $0.2/HBAR = $380
      expect(payload.fiatEquivalent).toBeCloseTo(380, 6);
    });
  });

  describe('Slack send is fire-and-forget', () => {
    it('does NOT turn pass into reject when Slack send fails', async () => {
      const sendSlackAlert = vi.fn(() => Promise.reject(new Error('slack down')));
      const deps = makeDeps({
        queryRemainingAllowanceHbar: () => Promise.resolve(2_500),
        sendSlackAlert,
      });
      const result = await treasuryAllowanceGuard({ ...baseInput, amountHbar: 600 }, deps);

      // Transfer decision is independent of Slack success.
      expect(result.passed).toBe(true);
      expect(result.alertFired).toBe(true);
      expect(result.remainingAllowanceAfter).toBeCloseTo(1_900, 6);

      // Give the microtask queue a turn so the rejected promise's .catch()
      // runs before test ends (keeps vitest from flagging an unhandled rejection).
      await new Promise((resolve) => setImmediate(resolve));
    });

    it('does NOT await the Slack send (hook returns before Slack resolves)', async () => {
      let slackResolved = false;
      const sendSlackAlert = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              slackResolved = true;
              resolve();
            }, 50);
          }),
      );
      const deps = makeDeps({
        queryRemainingAllowanceHbar: () => Promise.resolve(2_500),
        sendSlackAlert,
      });

      const result = await treasuryAllowanceGuard({ ...baseInput, amountHbar: 600 }, deps);
      // The hook returns before the 50ms Slack timer fires.
      expect(slackResolved).toBe(false);
      expect(result.passed).toBe(true);

      // Clean up the pending promise so no unhandled-rejection warnings.
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(slackResolved).toBe(true);
    });
  });

  describe('floating-point safety', () => {
    it('handles 0.1 + 0.2 amount against 0.3 remaining without false-rejecting', async () => {
      const deps = makeDeps({ queryRemainingAllowanceHbar: () => Promise.resolve(0.3) });
      const result = await treasuryAllowanceGuard({ ...baseInput, amountHbar: 0.1 + 0.2 }, deps);
      expect(result.passed).toBe(true);
    });
  });

  describe('correlationId passthrough', () => {
    it('accepts an optional correlationId without affecting decision', async () => {
      const deps = makeDeps({ queryRemainingAllowanceHbar: () => Promise.resolve(5_000) });
      const result = await treasuryAllowanceGuard(
        { ...baseInput, correlationId: 'corr-abc' },
        deps,
      );
      expect(result.passed).toBe(true);
    });
  });
});
