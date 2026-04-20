// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * Unit tests for `scripts/bootstrap-treasury.ts`.
 *
 * Pure helpers (`treasuryMemo`, `parseHbarEnv`) plus the DI'd
 * `runBootstrap` orchestrator are unit-tested here. The SDK wrappers
 * (`createTreasuryViaSdk`, `grantAllowanceViaSdk`) + `main()` are v8-ignored
 * — covered by E2E on real testnet in PR #17.
 */

/* eslint-disable @typescript-eslint/require-await -- mock `vi.fn(async () => value)` matches async signature without needing to await; noise to add `await`. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrivateKey } from '@hiero-ledger/sdk';
import {
  parseHbarEnv,
  runBootstrap,
  treasuryMemo,
  type BootstrapTreasuryDeps,
} from '../../scripts/bootstrap-treasury.js';
import type { BootstrapEnv } from '../../scripts/lib/bootstrapEnv.js';

describe('bootstrap-treasury / treasuryMemo', () => {
  it('produces canonical memo for a given env label', () => {
    expect(treasuryMemo('dev')).toBe('xeni_treasury_v1_dev');
  });

  it('embeds env label verbatim (not normalized)', () => {
    expect(treasuryMemo('testnet-UAT')).toBe('xeni_treasury_v1_testnet-UAT');
  });

  it('includes schema version segment for future v2 coexistence', () => {
    expect(treasuryMemo('dev')).toContain('_v1_');
  });
});

describe('bootstrap-treasury / parseHbarEnv', () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    delete process.env['HEDERA_TEST_AMOUNT'];
  });
  afterEach(() => {
    delete process.env['HEDERA_TEST_AMOUNT'];
    Object.assign(process.env, savedEnv);
  });

  it('returns the default when env var is unset', () => {
    expect(parseHbarEnv('HEDERA_TEST_AMOUNT', 10000)).toBe(10000);
  });

  it('returns the default when env var is empty / whitespace', () => {
    process.env['HEDERA_TEST_AMOUNT'] = '   ';
    expect(parseHbarEnv('HEDERA_TEST_AMOUNT', 10000)).toBe(10000);
  });

  it('parses a valid positive integer', () => {
    process.env['HEDERA_TEST_AMOUNT'] = '500';
    expect(parseHbarEnv('HEDERA_TEST_AMOUNT', 10000)).toBe(500);
  });

  it('parses a valid positive float', () => {
    process.env['HEDERA_TEST_AMOUNT'] = '0.5';
    expect(parseHbarEnv('HEDERA_TEST_AMOUNT', 10000)).toBe(0.5);
  });

  it('throws on non-numeric value', () => {
    process.env['HEDERA_TEST_AMOUNT'] = 'nope';
    expect(() => parseHbarEnv('HEDERA_TEST_AMOUNT', 10000)).toThrow(/not a positive finite number/);
  });

  it('throws on zero (must be positive)', () => {
    process.env['HEDERA_TEST_AMOUNT'] = '0';
    expect(() => parseHbarEnv('HEDERA_TEST_AMOUNT', 10000)).toThrow();
  });

  it('throws on negative value', () => {
    process.env['HEDERA_TEST_AMOUNT'] = '-100';
    expect(() => parseHbarEnv('HEDERA_TEST_AMOUNT', 10000)).toThrow();
  });

  it('throws on Infinity', () => {
    process.env['HEDERA_TEST_AMOUNT'] = 'Infinity';
    expect(() => parseHbarEnv('HEDERA_TEST_AMOUNT', 10000)).toThrow();
  });
});

describe('bootstrap-treasury / runBootstrap', () => {
  function buildEnv(): BootstrapEnv {
    return {
      operatorId: '0.0.1001',
      operatorKey: PrivateKey.generateECDSA(),
      network: 'testnet',
      envLabel: 'dev',
    };
  }

  function buildDeps(overrides: Partial<BootstrapTreasuryDeps> = {}): BootstrapTreasuryDeps {
    // Deterministic key for test assertions — DI'd via generateKey.
    const fixedKey = PrivateKey.generateECDSA();
    return {
      fetchAccountMemo: vi.fn(async () => null),
      createTreasury: vi.fn(async () => ({
        treasuryId: '0.0.2002',
        transactionId: '0.0.1001@1234567890.000000000',
      })),
      grantAllowance: vi.fn(async () => ({
        transactionId: '0.0.1001@1234567890.100000000',
      })),
      generateKey: () => fixedKey,
      logStderr: vi.fn(),
      printStdout: vi.fn(),
      ...overrides,
    };
  }

  // ==============================
  // Path 1: existing + memo matches (idempotent re-use)
  // ==============================
  describe('existing HEDERA_XENI_TREASURY_ID + matching memo → idempotent re-use', () => {
    it('returns created=false and does NOT call createTreasury / grantAllowance', async () => {
      const deps = buildDeps({
        fetchAccountMemo: vi.fn(async () => 'xeni_treasury_v1_dev'),
      });
      const result = await runBootstrap(
        {
          env: buildEnv(),
          agentId: '0.0.1002',
          initialBalanceHbar: 30000,
          initialAllowanceHbar: 10000,
          existingTreasuryId: '0.0.2002',
        },
        deps,
      );

      expect(result).toEqual({ treasuryId: '0.0.2002', created: false, allowanceHbar: 0 });
      expect(deps.createTreasury).not.toHaveBeenCalled();
      expect(deps.grantAllowance).not.toHaveBeenCalled();
      expect(deps.printStdout).toHaveBeenCalledWith(
        'HEDERA_XENI_TREASURY_ID=0.0.2002  # existing, unchanged',
      );
    });

    it('does NOT print the cold key on re-use path (key is never fetched)', async () => {
      const deps = buildDeps({
        fetchAccountMemo: vi.fn(async () => 'xeni_treasury_v1_dev'),
      });
      await runBootstrap(
        {
          env: buildEnv(),
          agentId: '0.0.1002',
          initialBalanceHbar: 30000,
          initialAllowanceHbar: 10000,
          existingTreasuryId: '0.0.2002',
        },
        deps,
      );
      const stdoutCalls = (deps.printStdout as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => c[0] as string)
        .join('\n');
      expect(stdoutCalls).not.toContain('HEDERA_XENI_TREASURY_KEY=');
      expect(stdoutCalls).not.toContain('COLD KEY');
    });
  });

  // ==============================
  // Path 2: existing + memo mismatch → throw
  // ==============================
  describe('existing HEDERA_XENI_TREASURY_ID + mismatched memo → throws loud', () => {
    it('throws with a message naming the actual memo + expected memo', async () => {
      const deps = buildDeps({
        fetchAccountMemo: vi.fn(async () => 'some_other_memo'),
      });
      await expect(
        runBootstrap(
          {
            env: buildEnv(),
            agentId: '0.0.1002',
            initialBalanceHbar: 30000,
            initialAllowanceHbar: 10000,
            existingTreasuryId: '0.0.9999',
          },
          deps,
        ),
      ).rejects.toThrow(/0\.0\.9999.*some_other_memo.*xeni_treasury_v1_dev/s);
      expect(deps.createTreasury).not.toHaveBeenCalled();
      expect(deps.grantAllowance).not.toHaveBeenCalled();
    });

    it('throws when account has no memo at all (null)', async () => {
      const deps = buildDeps({
        fetchAccountMemo: vi.fn(async () => null),
      });
      await expect(
        runBootstrap(
          {
            env: buildEnv(),
            agentId: '0.0.1002',
            initialBalanceHbar: 30000,
            initialAllowanceHbar: 10000,
            existingTreasuryId: '0.0.9999',
          },
          deps,
        ),
      ).rejects.toThrow(/not the expected "xeni_treasury_v1_dev"/);
    });
  });

  // ==============================
  // Path 3: no existing → create + grant + print key
  // ==============================
  describe('no HEDERA_XENI_TREASURY_ID → full bootstrap (create + grant + print cold key)', () => {
    it('creates treasury, grants allowance, returns created=true', async () => {
      const deps = buildDeps();
      const result = await runBootstrap(
        {
          env: buildEnv(),
          agentId: '0.0.1002',
          initialBalanceHbar: 30000,
          initialAllowanceHbar: 10000,
        },
        deps,
      );

      expect(result).toEqual({
        treasuryId: '0.0.2002',
        created: true,
        allowanceHbar: 10000,
      });
      expect(deps.createTreasury).toHaveBeenCalledOnce();
      expect(deps.grantAllowance).toHaveBeenCalledOnce();
    });

    it('passes memo "xeni_treasury_v1_<env>" to createTreasury', async () => {
      const deps = buildDeps();
      const env = { ...buildEnv(), envLabel: 'testnet-uat' };
      await runBootstrap(
        { env, agentId: '0.0.1002', initialBalanceHbar: 30000, initialAllowanceHbar: 10000 },
        deps,
      );
      const createCall = (deps.createTreasury as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        memo: string;
      };
      expect(createCall.memo).toBe('xeni_treasury_v1_testnet-uat');
    });

    it('wires grantAllowance with owner=treasury, spender=agent, and the signing key', async () => {
      const fixedKey = PrivateKey.generateECDSA();
      const deps = buildDeps({ generateKey: () => fixedKey });
      await runBootstrap(
        {
          env: buildEnv(),
          agentId: '0.0.1002',
          initialBalanceHbar: 30000,
          initialAllowanceHbar: 10000,
        },
        deps,
      );
      const grantCall = (deps.grantAllowance as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        treasuryId: string;
        agentId: string;
        treasuryKey: PrivateKey;
        allowanceHbar: number;
      };
      expect(grantCall.treasuryId).toBe('0.0.2002');
      expect(grantCall.agentId).toBe('0.0.1002');
      expect(grantCall.treasuryKey.toStringRaw()).toBe(fixedKey.toStringRaw());
      expect(grantCall.allowanceHbar).toBe(10000);
    });

    it('prints the cold key ONCE, with warning markers, on stdout', async () => {
      const fixedKey = PrivateKey.generateECDSA();
      const deps = buildDeps({ generateKey: () => fixedKey });
      await runBootstrap(
        {
          env: buildEnv(),
          agentId: '0.0.1002',
          initialBalanceHbar: 30000,
          initialAllowanceHbar: 10000,
        },
        deps,
      );
      const stdoutLines = (deps.printStdout as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => c[0] as string,
      );
      const joined = stdoutLines.join('\n');

      // Treasury ID line
      expect(joined).toContain('HEDERA_XENI_TREASURY_ID=0.0.2002  # newly created');
      // Cold-key warnings
      expect(joined).toContain('COLD KEY');
      expect(joined).toContain('offline storage');
      expect(joined).toContain('ONLY time');
      // Actual key line
      expect(joined).toContain(`HEDERA_XENI_TREASURY_KEY=${fixedKey.toStringRaw()}`);
      // Initial allowance note
      expect(joined).toContain('Initial allowance: 10000 HBAR, spender=0.0.1002');

      // Sanity: cold key appears EXACTLY once (no accidental echo)
      const keyOccurrences = stdoutLines.filter((l) =>
        l.includes(`HEDERA_XENI_TREASURY_KEY=${fixedKey.toStringRaw()}`),
      ).length;
      expect(keyOccurrences).toBe(1);
    });

    it('warns loudly when allowance > balance (misconfig)', async () => {
      const deps = buildDeps();
      await runBootstrap(
        {
          env: buildEnv(),
          agentId: '0.0.1002',
          initialBalanceHbar: 100,
          initialAllowanceHbar: 500,
        },
        deps,
      );
      const stderrLines = (deps.logStderr as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => c[0] as string,
      );
      const joined = stderrLines.join('\n');
      expect(joined).toContain('WARN');
      expect(joined).toContain('allowance (500 HBAR) exceeds initial balance (100 HBAR)');
    });

    it('does NOT warn when allowance <= balance', async () => {
      const deps = buildDeps();
      await runBootstrap(
        {
          env: buildEnv(),
          agentId: '0.0.1002',
          initialBalanceHbar: 30000,
          initialAllowanceHbar: 10000,
        },
        deps,
      );
      const stderrLines = (deps.logStderr as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => c[0] as string,
      );
      expect(stderrLines.some((l) => l.includes('WARN'))).toBe(false);
    });

    it('propagates errors from createTreasury (fails loud before grantAllowance fires)', async () => {
      const deps = buildDeps({
        createTreasury: vi.fn(async () => {
          throw new Error('INSUFFICIENT_PAYER_BALANCE');
        }),
      });
      await expect(
        runBootstrap(
          {
            env: buildEnv(),
            agentId: '0.0.1002',
            initialBalanceHbar: 30000,
            initialAllowanceHbar: 10000,
          },
          deps,
        ),
      ).rejects.toThrow(/INSUFFICIENT_PAYER_BALANCE/);
      expect(deps.grantAllowance).not.toHaveBeenCalled();
    });

    it('propagates errors from grantAllowance — treasury already created, but bootstrap fails', async () => {
      const deps = buildDeps({
        grantAllowance: vi.fn(async () => {
          throw new Error('INVALID_SIGNATURE');
        }),
      });
      await expect(
        runBootstrap(
          {
            env: buildEnv(),
            agentId: '0.0.1002',
            initialBalanceHbar: 30000,
            initialAllowanceHbar: 10000,
          },
          deps,
        ),
      ).rejects.toThrow(/INVALID_SIGNATURE/);
      // createTreasury did fire — treasury now exists on-chain. Ops sees the
      // error, can manually grant allowance via a separate tx. The error
      // message is the caller's signal to check state.
      expect(deps.createTreasury).toHaveBeenCalledOnce();
    });
  });
});
