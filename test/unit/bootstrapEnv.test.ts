// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * Unit tests for `scripts/lib/bootstrapEnv.ts` — the shared env loader
 * used by M3 audit-topic + M4 treasury bootstrap scripts.
 *
 * Coverage: required vars, malformed operator key, invalid network value,
 * the happy path.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrivateKey } from '@hiero-ledger/sdk';
import { loadBootstrapEnv } from '../../scripts/lib/bootstrapEnv.js';

/** Generate a format-valid operator key for the happy-path tests. */
function freshOperatorKey(): string {
  return PrivateKey.generateECDSA().toStringRaw();
}

describe('bootstrapEnv / loadBootstrapEnv', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('HEDERA_')) delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('HEDERA_')) delete process.env[k];
    }
    Object.assign(process.env, savedEnv);
  });

  it('throws when HEDERA_OPERATOR_ID is missing', () => {
    process.env['HEDERA_OPERATOR_KEY'] = freshOperatorKey();
    process.env['HEDERA_NETWORK'] = 'testnet';
    process.env['HEDERA_ENV_LABEL'] = 'dev';
    expect(() => loadBootstrapEnv()).toThrow(/HEDERA_OPERATOR_ID/);
  });

  it('throws when HEDERA_OPERATOR_KEY is missing', () => {
    process.env['HEDERA_OPERATOR_ID'] = '0.0.1001';
    process.env['HEDERA_NETWORK'] = 'testnet';
    process.env['HEDERA_ENV_LABEL'] = 'dev';
    expect(() => loadBootstrapEnv()).toThrow(/HEDERA_OPERATOR_KEY/);
  });

  it('throws when HEDERA_OPERATOR_KEY is malformed (fail-loud before any network call)', () => {
    process.env['HEDERA_OPERATOR_ID'] = '0.0.1001';
    process.env['HEDERA_OPERATOR_KEY'] = 'not-a-valid-hex-key';
    process.env['HEDERA_NETWORK'] = 'testnet';
    process.env['HEDERA_ENV_LABEL'] = 'dev';
    expect(() => loadBootstrapEnv()).toThrow(/valid ECDSA private key/);
  });

  it('throws when HEDERA_NETWORK is missing', () => {
    process.env['HEDERA_OPERATOR_ID'] = '0.0.1001';
    process.env['HEDERA_OPERATOR_KEY'] = freshOperatorKey();
    process.env['HEDERA_ENV_LABEL'] = 'dev';
    expect(() => loadBootstrapEnv()).toThrow(/HEDERA_NETWORK/);
  });

  it('throws when HEDERA_NETWORK is an unknown value (e.g. "previewnet")', () => {
    process.env['HEDERA_OPERATOR_ID'] = '0.0.1001';
    process.env['HEDERA_OPERATOR_KEY'] = freshOperatorKey();
    process.env['HEDERA_NETWORK'] = 'previewnet';
    process.env['HEDERA_ENV_LABEL'] = 'dev';
    expect(() => loadBootstrapEnv()).toThrow(/testnet.*mainnet/);
  });

  it('throws when HEDERA_ENV_LABEL is missing', () => {
    process.env['HEDERA_OPERATOR_ID'] = '0.0.1001';
    process.env['HEDERA_OPERATOR_KEY'] = freshOperatorKey();
    process.env['HEDERA_NETWORK'] = 'testnet';
    expect(() => loadBootstrapEnv()).toThrow(/HEDERA_ENV_LABEL/);
  });

  it('loads successfully with valid env (happy path)', () => {
    const key = freshOperatorKey();
    process.env['HEDERA_OPERATOR_ID'] = '0.0.1001';
    process.env['HEDERA_OPERATOR_KEY'] = key;
    process.env['HEDERA_NETWORK'] = 'testnet';
    process.env['HEDERA_ENV_LABEL'] = 'testnet-uat';

    const env = loadBootstrapEnv();
    expect(env.operatorId).toBe('0.0.1001');
    expect(env.network).toBe('testnet');
    expect(env.envLabel).toBe('testnet-uat');
    expect(env.operatorKey).toBeInstanceOf(PrivateKey);
    // operatorKey round-trips to the same raw string (sanity)
    expect(env.operatorKey.toStringRaw()).toBe(key);
  });

  it('accepts mainnet as a valid network', () => {
    process.env['HEDERA_OPERATOR_ID'] = '0.0.1001';
    process.env['HEDERA_OPERATOR_KEY'] = freshOperatorKey();
    process.env['HEDERA_NETWORK'] = 'mainnet';
    process.env['HEDERA_ENV_LABEL'] = 'mainnet-prod';
    expect(() => loadBootstrapEnv()).not.toThrow();
    expect(loadBootstrapEnv().network).toBe('mainnet');
  });

  it('rejects empty-string values (same as missing)', () => {
    process.env['HEDERA_OPERATOR_ID'] = '   ';
    process.env['HEDERA_OPERATOR_KEY'] = freshOperatorKey();
    process.env['HEDERA_NETWORK'] = 'testnet';
    process.env['HEDERA_ENV_LABEL'] = 'dev';
    expect(() => loadBootstrapEnv()).toThrow(/HEDERA_OPERATOR_ID/);
  });
});
