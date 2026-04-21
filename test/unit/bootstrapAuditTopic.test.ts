// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * Unit tests for the pure-function exports of
 * `scripts/bootstrap-audit-topic.ts`.
 *
 * The `main()` function itself is CLI-scope and tested via E2E in PR #17.
 * The pure helpers (memo builder, Mirror Node key parser) + the DI'd
 * `runBootstrap` orchestrator are tested here so the idempotency-key
 * format, key-type dispatch, and both bootstrap branches (re-use / create)
 * have explicit regression coverage without touching a real network or
 * the Hiero SDK.
 */

/* eslint-disable @typescript-eslint/require-await -- mock `vi.fn(async () => value)` matches the real async signature even when the body doesn't need to await; adding `await` inside would just be noise. */

import { describe, expect, it, vi } from 'vitest';
import { PrivateKey, PublicKey } from '@hiero-ledger/sdk';
import {
  auditTopicMemo,
  parseMirrorPublicKey,
  runBootstrap,
  type BootstrapAuditTopicDeps,
} from '../../scripts/bootstrap-audit-topic.js';
import type { BootstrapEnv } from '../../scripts/lib/bootstrapEnv.js';

describe('bootstrap-audit-topic / auditTopicMemo', () => {
  it('produces the canonical memo for a given env label', () => {
    expect(auditTopicMemo('dev')).toBe('xeni_audit_v1_dev');
  });

  it('embeds the env label verbatim (not normalized)', () => {
    // Ensures we never silently lower-case or transform — the memo is an
    // idempotency key and any transformation would mean a re-run creates
    // a duplicate topic.
    expect(auditTopicMemo('testnet-UAT')).toBe('xeni_audit_v1_testnet-UAT');
    expect(auditTopicMemo('mainnet-prod')).toBe('xeni_audit_v1_mainnet-prod');
  });

  it('includes the schema version so future v2 can coexist', () => {
    // If we ever need a v2 schema, the new memo format is `xeni_audit_v2_<env>`
    // and the old topics remain untouched. Lock the `_v1_` segment in.
    expect(auditTopicMemo('dev')).toContain('_v1_');
  });
});

describe('bootstrap-audit-topic / parseMirrorPublicKey', () => {
  it('parses an ECDSA_SECP256K1 key', () => {
    const pk = PrivateKey.generateECDSA().publicKey;
    const hex = pk.toStringRaw();
    const parsed = parseMirrorPublicKey('ECDSA_SECP256K1', hex);
    expect(parsed).toBeInstanceOf(PublicKey);
    expect(parsed.toStringRaw()).toBe(hex);
  });

  it('parses an ED25519 key', () => {
    const pk = PrivateKey.generateED25519().publicKey;
    const hex = pk.toStringRaw();
    const parsed = parseMirrorPublicKey('ED25519', hex);
    expect(parsed).toBeInstanceOf(PublicKey);
    expect(parsed.toStringRaw()).toBe(hex);
  });

  it('throws on an unsupported key type', () => {
    expect(() => parseMirrorPublicKey('RSA', 'deadbeef')).toThrow(
      /Unsupported Mirror Node key type.*RSA/,
    );
  });

  it('throws on malformed hex (propagated from the SDK)', () => {
    expect(() => parseMirrorPublicKey('ECDSA_SECP256K1', 'not-hex')).toThrow();
  });
});

describe('bootstrap-audit-topic / runBootstrap', () => {
  /**
   * Build a freshly-mocked deps bag for each test. Individual tests can
   * override specific fields to exercise a particular branch. Deps shape
   * mirrors M4's `BootstrapTreasuryDeps` after the issue #18 fix.
   */
  function buildDeps(overrides: Partial<BootstrapAuditTopicDeps> = {}): BootstrapAuditTopicDeps {
    return {
      fetchTopicMemo: vi.fn(async () => null),
      fetchAccountPublicKey: vi.fn(async () => ({
        type: 'ECDSA_SECP256K1',
        hex: PrivateKey.generateECDSA().publicKey.toStringRaw(),
      })),
      createTopic: vi.fn(async () => ({
        topicId: '0.0.9002',
        transactionId: '0.0.1001@1234567890.123456789',
      })),
      logStderr: vi.fn(),
      printMachineOutput: vi.fn(),
      ...overrides,
    };
  }

  function buildEnv(): BootstrapEnv {
    return {
      operatorId: '0.0.1001',
      operatorKey: PrivateKey.generateECDSA(),
      network: 'testnet',
      envLabel: 'dev',
    };
  }

  // ==============================
  // Path 1: existing + memo matches (idempotent re-use)
  // ==============================
  describe('existing HEDERA_XENI_AUDIT_TOPIC_ID + matching memo → idempotent re-use', () => {
    it('returns created=false and does NOT call fetchAccountPublicKey / createTopic', async () => {
      const deps = buildDeps({
        fetchTopicMemo: vi.fn(async () => 'xeni_audit_v1_dev'),
      });
      const result = await runBootstrap(
        { env: buildEnv(), agentId: '0.0.1002', existingTopicId: '0.0.8888' },
        deps,
      );

      expect(result).toEqual({ topicId: '0.0.8888', created: false });
      expect(deps.fetchAccountPublicKey).not.toHaveBeenCalled();
      expect(deps.createTopic).not.toHaveBeenCalled();
      expect(deps.printMachineOutput).toHaveBeenCalledWith('0.0.8888', 'existing, unchanged');
    });

    it('passes the right (topicId, network) to fetchTopicMemo for verification', async () => {
      const deps = buildDeps({
        fetchTopicMemo: vi.fn(async () => 'xeni_audit_v1_testnet-ci'),
      });
      const env = { ...buildEnv(), envLabel: 'testnet-ci' };
      await runBootstrap({ env, agentId: '0.0.1002', existingTopicId: '0.0.8719397' }, deps);

      expect(deps.fetchTopicMemo).toHaveBeenCalledWith('0.0.8719397', 'testnet');
    });
  });

  // ==============================
  // Path 2: existing + memo mismatch → throw
  // ==============================
  describe('existing HEDERA_XENI_AUDIT_TOPIC_ID + mismatched memo → throws loud', () => {
    it('throws with a message naming actual + expected memo + topic ID', async () => {
      const deps = buildDeps({
        fetchTopicMemo: vi.fn(async () => 'some_other_memo'),
      });
      await expect(
        runBootstrap({ env: buildEnv(), agentId: '0.0.1002', existingTopicId: '0.0.9999' }, deps),
      ).rejects.toThrow(/0\.0\.9999.*some_other_memo.*xeni_audit_v1_dev/s);
      expect(deps.fetchAccountPublicKey).not.toHaveBeenCalled();
      expect(deps.createTopic).not.toHaveBeenCalled();
    });

    it('throws when topic has no memo at all (null)', async () => {
      const deps = buildDeps({
        fetchTopicMemo: vi.fn(async () => null),
      });
      await expect(
        runBootstrap({ env: buildEnv(), agentId: '0.0.1002', existingTopicId: '0.0.9999' }, deps),
      ).rejects.toThrow(/not the expected "xeni_audit_v1_dev"/);
    });

    it('propagates fetchTopicMemo HTTP errors (404, 503, etc.) rather than silently proceeding', async () => {
      const deps = buildDeps({
        fetchTopicMemo: vi.fn(async () => {
          throw new Error('Mirror Node returned HTTP 404 for /api/v1/topics/0.0.9999');
        }),
      });
      await expect(
        runBootstrap({ env: buildEnv(), agentId: '0.0.1002', existingTopicId: '0.0.9999' }, deps),
      ).rejects.toThrow(/HTTP 404/);
      // Never reached the create path
      expect(deps.createTopic).not.toHaveBeenCalled();
    });
  });

  // ==============================
  // Path 3: no existing → create + print
  // ==============================
  describe('no HEDERA_XENI_AUDIT_TOPIC_ID → full bootstrap (create + print)', () => {
    it('fetches agent key, creates topic, returns created=true', async () => {
      const agentPubHex = PrivateKey.generateECDSA().publicKey.toStringRaw();
      const deps = buildDeps({
        fetchAccountPublicKey: vi.fn(async () => ({ type: 'ECDSA_SECP256K1', hex: agentPubHex })),
      });
      const result = await runBootstrap({ env: buildEnv(), agentId: '0.0.1002' }, deps);

      expect(result).toEqual({ topicId: '0.0.9002', created: true });
      expect(deps.fetchTopicMemo).not.toHaveBeenCalled(); // no existingTopicId → skip verification
      expect(deps.fetchAccountPublicKey).toHaveBeenCalledWith('0.0.1002', 'testnet');
      expect(deps.createTopic).toHaveBeenCalledOnce();
      expect(deps.printMachineOutput).toHaveBeenCalledWith('0.0.9002', 'newly created');
    });

    it('passes memo "xeni_audit_v1_<envLabel>" to createTopic verbatim', async () => {
      const deps = buildDeps();
      const env = { ...buildEnv(), envLabel: 'testnet-uat' };
      await runBootstrap({ env, agentId: '0.0.1002' }, deps);

      const createCall = (deps.createTopic as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        memo: string;
      };
      expect(createCall.memo).toBe('xeni_audit_v1_testnet-uat');
    });

    it('wires admin_key = operator.publicKey and submit_key = agent.publicKey', async () => {
      const env = buildEnv();
      const agentKey = PrivateKey.generateECDSA();
      const agentPubHex = agentKey.publicKey.toStringRaw();

      const deps = buildDeps({
        fetchAccountPublicKey: vi.fn(async () => ({ type: 'ECDSA_SECP256K1', hex: agentPubHex })),
      });
      await runBootstrap({ env, agentId: '0.0.1002' }, deps);

      const createCall = (deps.createTopic as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        adminKey: PublicKey;
        submitKey: PublicKey;
      };
      expect(createCall.adminKey.toStringRaw()).toBe(env.operatorKey.publicKey.toStringRaw());
      expect(createCall.submitKey.toStringRaw()).toBe(agentPubHex);
      expect(createCall.adminKey.toStringRaw()).not.toBe(createCall.submitKey.toStringRaw());
    });

    it('parses ED25519 agent keys (Mirror Node may return either algorithm)', async () => {
      const agentKey = PrivateKey.generateED25519();
      const deps = buildDeps({
        fetchAccountPublicKey: vi.fn(async () => ({
          type: 'ED25519',
          hex: agentKey.publicKey.toStringRaw(),
        })),
      });
      const result = await runBootstrap({ env: buildEnv(), agentId: '0.0.1002' }, deps);
      expect(result.created).toBe(true);
      const createCall = (deps.createTopic as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        submitKey: PublicKey;
      };
      expect(createCall.submitKey.toStringRaw()).toBe(agentKey.publicKey.toStringRaw());
    });

    it('propagates errors from fetchAccountPublicKey (fails loud before createTopic fires)', async () => {
      const deps = buildDeps({
        fetchAccountPublicKey: vi.fn(async () => {
          throw new Error('no single-key');
        }),
      });
      await expect(runBootstrap({ env: buildEnv(), agentId: '0.0.1002' }, deps)).rejects.toThrow(
        /no single-key/,
      );
      expect(deps.createTopic).not.toHaveBeenCalled();
    });

    it('propagates errors from createTopic (SDK failure, no output printed)', async () => {
      const deps = buildDeps({
        createTopic: vi.fn(async () => {
          throw new Error('INSUFFICIENT_PAYER_BALANCE');
        }),
      });
      await expect(runBootstrap({ env: buildEnv(), agentId: '0.0.1002' }, deps)).rejects.toThrow(
        /INSUFFICIENT_PAYER_BALANCE/,
      );
      expect(deps.printMachineOutput).not.toHaveBeenCalled();
    });
  });
});
