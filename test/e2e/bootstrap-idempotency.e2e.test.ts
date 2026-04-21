// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * E2E: bootstrap scripts' idempotent re-read paths against real Mirror Node.
 *
 * Validates that both bootstrap scripts, when given an env that already
 * has the relevant ID set (which testnet-ci does after its one-time
 * bootstrap), follow the "existing" path rather than attempting to create
 * new on-chain state. This exercises the Mirror Node lookup layer end-
 * to-end (`fetchTopicMemo` for M3, `fetchAccountMemo` for M4) against the
 * real API.
 *
 * Scope: the CREATE paths (`createTopicViaSdk`, `createTreasuryViaSdk`,
 * `grantAllowanceViaSdk`) are NOT exercised here — they'd mint new
 * on-chain state every nightly run, accumulating testnet garbage + cost.
 * The create paths get their real validation during Anand's one-time
 * cutover runs. What we validate here is the more common ops path:
 * re-running the script on an already-bootstrapped env and getting a
 * clean "existing, unchanged" response.
 *
 * Runs only on the nightly CI job or with locally-exported testnet creds.
 */

import { describe, expect, it } from 'vitest';
import { PrivateKey } from '@hiero-ledger/sdk';
import type { BootstrapEnv } from '../../scripts/lib/bootstrapEnv.js';
import {
  runBootstrap as runAuditTopicBootstrap,
  type BootstrapAuditTopicDeps,
} from '../../scripts/bootstrap-audit-topic.js';
import {
  runBootstrap as runTreasuryBootstrap,
  type BootstrapTreasuryDeps,
} from '../../scripts/bootstrap-treasury.js';
import { fetchAccountMemo, fetchTopicMemo } from '../../scripts/lib/mirrorLookup.js';
import { missingE2EEnv } from './_helpers.js';

const missing = missingE2EEnv([
  'HEDERA_ENV_LABEL',
  'HEDERA_XENI_TREASURY_ID',
  'HEDERA_XENI_AUDIT_TOPIC_ID',
]);

/**
 * Build a BootstrapEnv for the idempotent re-use path without going through
 * `loadBootstrapEnv()`.
 *
 * `loadBootstrapEnv()` reads `HEDERA_OPERATOR_ID` + `HEDERA_OPERATOR_KEY`
 * from `process.env` and fail-validates the key's ECDSA format. In CI, that
 * forces the workflow env block to include `HEDERA_OPERATOR_KEY` — which
 * then trips `warnIfColdKeyLeaked()` in `src/accounts.ts` when the
 * server-wiring E2E runs in the same process (issue #21).
 *
 * The idempotent re-use path never signs anything on behalf of the
 * operator: `createTopic`, `createTreasury`, and `grantAllowance` are
 * wired as throw-if-called stubs in both M3 and M4 tests below. The
 * operator key would only matter if control reached those stubs — by
 * design, it can't. So a freshly-generated throwaway ECDSA key satisfies
 * the type without ever being exercised.
 *
 * `network` + `envLabel` are still read from `process.env` because the
 * Mirror Node base URL and the expected memo string both depend on them.
 */
function buildReuseEnv(): BootstrapEnv {
  const rawNetwork = process.env['HEDERA_NETWORK'];
  if (rawNetwork !== 'testnet' && rawNetwork !== 'mainnet') {
    throw new Error(
      `HEDERA_NETWORK must be "testnet" or "mainnet" for this E2E, got: "${rawNetwork ?? ''}"`,
    );
  }
  return {
    operatorId: '0.0.0',
    operatorKey: PrivateKey.generateECDSA(),
    network: rawNetwork,
    envLabel: process.env['HEDERA_ENV_LABEL']!,
  };
}

/**
 * Capture printStdout/logStderr into arrays so test assertions can check
 * the output contract without relying on real stdout/stderr.
 */
function capturingDeps(): {
  stdout: string[];
  stderr: string[];
  depOverrides: {
    logStderr: (m: string) => void;
    printStdout: (l: string) => void;
    printMachineOutput: (id: string, note: string) => void;
  };
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    depOverrides: {
      logStderr: (m: string) => stderr.push(m),
      printStdout: (l: string) => stdout.push(l),
      // M3's deps use a different output shape (split kv+note); capture
      // it as a single reconstructed line so test assertions line up.
      printMachineOutput: (id: string, note: string) =>
        stdout.push(`HEDERA_XENI_AUDIT_TOPIC_ID=${id}  # ${note}`),
    },
  };
}

describe.skipIf(missing.length > 0)('E2E / bootstrap idempotency (real Mirror Node)', () => {
  it('M3 bootstrap-audit-topic re-run verifies existing topic via memo check (no new tx)', async () => {
    const env = buildReuseEnv();
    const agentId = process.env['HEDERA_AGENT_ID']!;
    const existingTopicId = process.env['HEDERA_XENI_AUDIT_TOPIC_ID']!;
    const { stdout, stderr, depOverrides } = capturingDeps();

    // Wire the real Mirror Node helper (`fetchTopicMemo`) — the whole
    // point of this test is to exercise it against live Mirror Node.
    // fetchAccountPublicKey + createTopic are NOT reached on the re-use
    // path; stub them as throw-if-called guards so any regression that
    // routes through the create path fails loudly rather than silently
    // racking up nightly testnet cost.
    const deps: BootstrapAuditTopicDeps = {
      fetchTopicMemo,
      fetchAccountPublicKey: () => {
        throw new Error('fetchAccountPublicKey must NOT be called on the idempotent re-use path');
      },
      createTopic: () => {
        throw new Error(
          'createTopic must NOT be called when HEDERA_XENI_AUDIT_TOPIC_ID memo already matches',
        );
      },
      logStderr: depOverrides.logStderr,
      printMachineOutput: depOverrides.printMachineOutput,
    };

    const result = await runAuditTopicBootstrap({ env, agentId, existingTopicId }, deps);

    expect(result.created).toBe(false);
    expect(result.topicId).toBe(existingTopicId);
    expect(stdout.join('\n')).toContain('existing, unchanged');
    expect(stderr.join('\n')).toContain('memo matches');
  }, 30_000); // Mirror Node single-topic lookup is a direct GET /api/v1/topics/{id}

  it('M4 bootstrap-treasury re-run verifies memo match (no new tx, no key printed)', async () => {
    const env = buildReuseEnv();
    const agentId = process.env['HEDERA_AGENT_ID']!;
    const existingTreasuryId = process.env['HEDERA_XENI_TREASURY_ID']!;
    const { stdout, stderr, depOverrides } = capturingDeps();

    const deps: BootstrapTreasuryDeps = {
      fetchAccountMemo,
      // Neither createTreasury nor grantAllowance should fire on the
      // idempotent path. Same guard-stub pattern as M3.
      createTreasury: () => {
        throw new Error(
          'createTreasury must NOT be called when HEDERA_XENI_TREASURY_ID memo already matches',
        );
      },
      grantAllowance: () => {
        throw new Error('grantAllowance must NOT be called on the idempotent re-use path');
      },
      generateKey: () => {
        throw new Error('generateKey must NOT be called on the idempotent re-use path');
      },
      logStderr: depOverrides.logStderr,
      printStdout: depOverrides.printStdout,
    };

    // Set balance + allowance to 0 deliberately: the re-use path does NOT
    // consume these values (it returns before `createTreasury` /
    // `grantAllowance` fire). Using 0 means a regression that DOES start
    // consuming them in the re-use path would fail obviously — either via
    // a "non-positive amount" error from the Hiero SDK, or a WARN log
    // about "allowance exceeds balance" when both are zero. Matches the
    // throw-if-called-stubs spirit of making regressions loud.
    const result = await runTreasuryBootstrap(
      {
        env,
        agentId,
        initialBalanceHbar: 0,
        initialAllowanceHbar: 0,
        existingTreasuryId,
      },
      deps,
    );

    expect(result.created).toBe(false);
    expect(result.treasuryId).toBe(existingTreasuryId);
    expect(result.allowanceHbar).toBe(0);

    const stdoutJoined = stdout.join('\n');
    expect(stdoutJoined).toContain('existing, unchanged');
    // Cold-key invariant: the key must NEVER appear in the re-use path
    expect(stdoutJoined).not.toContain('HEDERA_XENI_TREASURY_KEY=');
    expect(stdoutJoined).not.toContain('COLD KEY');

    expect(stderr.join('\n')).toContain('memo matches');
  }, 30_000);
});

describe.skipIf(missing.length === 0)('E2E / bootstrap-idempotency — SKIPPED (missing env)', () => {
  it('reports missing env vars', () => {
    // eslint-disable-next-line no-console -- intentional skip diagnostic
    console.warn(`[e2e/bootstrap-idempotency] Skipped. Missing env: ${missing.join(', ')}.`);
    expect(missing.length).toBeGreaterThan(0);
  });
});
