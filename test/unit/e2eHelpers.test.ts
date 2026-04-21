// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * Regression guards for `test/e2e/_helpers.ts`.
 *
 * Issue #21 root cause: `REQUIRED_BASE_ENV` previously included
 * `HEDERA_OPERATOR_ID` + `HEDERA_OPERATOR_KEY`, which forced the CI
 * workflow to set those vars — tripping `warnIfColdKeyLeaked()` in
 * `src/accounts.ts` when `server-wiring.e2e.test.ts` ran in the same
 * process. Silent drift (someone re-adding them to the required list)
 * would silently reopen the same WARN noise. These tests lock that down.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { missingBaseE2EEnv, missingE2EEnv } from '../e2e/_helpers.js';

describe('e2e/_helpers / cold-key invariant', () => {
  const baseEnvKeys = [
    'HEDERA_AGENT_ID',
    'HEDERA_AGENT_KEY',
    'HEDERA_NETWORK',
    'HEDERA_OPERATOR_ID',
    'HEDERA_OPERATOR_KEY',
    'HEDERA_ENV_LABEL',
    'HEDERA_XENI_AUDIT_TOPIC_ID',
    'HEDERA_XENI_TREASURY_ID',
  ] as const;

  beforeEach(() => {
    for (const k of baseEnvKeys) delete process.env[k];
  });

  it('missingBaseE2EEnv returns empty when only agent + network vars are set (no operator creds)', () => {
    process.env['HEDERA_AGENT_ID'] = '0.0.1001';
    process.env['HEDERA_AGENT_KEY'] = 'key';
    process.env['HEDERA_NETWORK'] = 'testnet';
    expect(missingBaseE2EEnv()).toEqual([]);
  });

  it('missingBaseE2EEnv does NOT require HEDERA_OPERATOR_ID (issue #21)', () => {
    process.env['HEDERA_AGENT_ID'] = '0.0.1001';
    process.env['HEDERA_AGENT_KEY'] = 'key';
    process.env['HEDERA_NETWORK'] = 'testnet';
    // HEDERA_OPERATOR_ID intentionally unset
    expect(missingBaseE2EEnv()).not.toContain('HEDERA_OPERATOR_ID');
  });

  it('missingBaseE2EEnv does NOT require HEDERA_OPERATOR_KEY (issue #21)', () => {
    process.env['HEDERA_AGENT_ID'] = '0.0.1001';
    process.env['HEDERA_AGENT_KEY'] = 'key';
    process.env['HEDERA_NETWORK'] = 'testnet';
    // HEDERA_OPERATOR_KEY intentionally unset
    expect(missingBaseE2EEnv()).not.toContain('HEDERA_OPERATOR_KEY');
  });

  it('missingBaseE2EEnv reports each missing agent/network var by name', () => {
    expect(missingBaseE2EEnv()).toEqual(
      expect.arrayContaining(['HEDERA_AGENT_ID', 'HEDERA_AGENT_KEY', 'HEDERA_NETWORK']),
    );
  });

  it('missingBaseE2EEnv treats blank values (whitespace-only) as missing', () => {
    process.env['HEDERA_AGENT_ID'] = '   ';
    process.env['HEDERA_AGENT_KEY'] = '';
    process.env['HEDERA_NETWORK'] = 'testnet';
    const missing = missingBaseE2EEnv();
    expect(missing).toContain('HEDERA_AGENT_ID');
    expect(missing).toContain('HEDERA_AGENT_KEY');
    expect(missing).not.toContain('HEDERA_NETWORK');
  });

  it('missingE2EEnv composes base + extras', () => {
    process.env['HEDERA_AGENT_ID'] = '0.0.1001';
    process.env['HEDERA_AGENT_KEY'] = 'key';
    process.env['HEDERA_NETWORK'] = 'testnet';
    // HEDERA_XENI_AUDIT_TOPIC_ID intentionally unset
    expect(missingE2EEnv(['HEDERA_XENI_AUDIT_TOPIC_ID'])).toEqual(['HEDERA_XENI_AUDIT_TOPIC_ID']);
  });

  it('missingE2EEnv returns empty when base + all extras are set', () => {
    process.env['HEDERA_AGENT_ID'] = '0.0.1001';
    process.env['HEDERA_AGENT_KEY'] = 'key';
    process.env['HEDERA_NETWORK'] = 'testnet';
    process.env['HEDERA_XENI_AUDIT_TOPIC_ID'] = '0.0.9999';
    process.env['HEDERA_XENI_TREASURY_ID'] = '0.0.9998';
    expect(missingE2EEnv(['HEDERA_XENI_AUDIT_TOPIC_ID', 'HEDERA_XENI_TREASURY_ID'])).toEqual([]);
  });
});
