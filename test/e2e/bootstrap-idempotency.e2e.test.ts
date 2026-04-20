// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * E2E: bootstrap scripts' idempotent re-read paths against real Mirror Node.
 *
 * Validates that both bootstrap scripts, when given an env that already
 * has the relevant ID set (which testnet-ci does after its one-time
 * bootstrap), follow the "existing" path rather than attempting to create
 * new on-chain state. This exercises the Mirror Node lookup layer end-
 * to-end (`findTopicByMemo` for M3, `fetchAccountMemo` for M4) against
 * the real API.
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
import { loadBootstrapEnv } from '../../scripts/lib/bootstrapEnv.js';
import {
  runBootstrap as runAuditTopicBootstrap,
  type BootstrapAuditTopicDeps,
} from '../../scripts/bootstrap-audit-topic.js';
import {
  runBootstrap as runTreasuryBootstrap,
  type BootstrapTreasuryDeps,
} from '../../scripts/bootstrap-treasury.js';
import {
  fetchAccountMemo,
  fetchAccountPublicKey,
  findTopicByMemo,
} from '../../scripts/lib/mirrorLookup.js';
import { missingE2EEnv } from './_helpers.js';

const missing = missingE2EEnv([
  'HEDERA_ENV_LABEL',
  'HEDERA_XENI_TREASURY_ID',
  'HEDERA_XENI_AUDIT_TOPIC_ID',
]);

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
  it('M3 bootstrap-audit-topic re-run finds the existing topic by memo (no new tx)', async () => {
    const env = loadBootstrapEnv();
    const agentId = process.env['HEDERA_AGENT_ID']!;
    const { stdout, stderr, depOverrides } = capturingDeps();

    // We wire the real Mirror Node helpers here (the goal is exactly
    // to exercise them). The SDK wrappers are ALSO wired, but the
    // idempotent path returns before calling them.
    const deps: BootstrapAuditTopicDeps = {
      findTopicByMemo,
      fetchAccountPublicKey,
      // createTopic SHOULD NOT fire on the idempotent path. Passing a
      // throw-if-called stub so a regression (re-creating topics every
      // night) fails loudly rather than silently racking up testnet
      // cost.
      createTopic: () => {
        throw new Error(
          'createTopic must NOT be called when HEDERA_XENI_AUDIT_TOPIC_ID memo already exists',
        );
      },
      logStderr: depOverrides.logStderr,
      printMachineOutput: depOverrides.printMachineOutput,
    };

    const result = await runAuditTopicBootstrap({ env, agentId }, deps);

    expect(result.created).toBe(false);
    expect(result.topicId).toBe(process.env['HEDERA_XENI_AUDIT_TOPIC_ID']);
    expect(stdout.join('\n')).toContain('existing, unchanged');
    expect(stderr.join('\n')).toContain('found existing topic');
  }, 60_000); // Mirror Node pagination walk can take a few seconds on testnet

  it('M4 bootstrap-treasury re-run verifies memo match (no new tx, no key printed)', async () => {
    const env = loadBootstrapEnv();
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
