// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * Unit tests for `scripts/lib/bootstrapEnv.ts` — the shared env loader
 * used by M3 audit-topic + M4 treasury bootstrap scripts.
 *
 * Coverage: required vars, malformed operator key, invalid network value,
 * the happy path, and fail-fast on the URL env vars (no hardcoded
 * defaults per docs/DESIGN.md §3).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrivateKey } from '@hiero-ledger/sdk';
import { loadBootstrapEnv } from '../../scripts/lib/bootstrapEnv.js';

/** Generate a format-valid operator key for the happy-path tests. */
function freshOperatorKey(): string {
  return PrivateKey.generateECDSA().toStringRaw();
}

/**
 * Set every required env var to a valid value. Individual tests clear
 * (or override to invalid) the specific var they want to exercise.
 */
function setValidBootstrapEnv(): void {
  process.env['HEDERA_OPERATOR_ID'] = '0.0.1001';
  process.env['HEDERA_OPERATOR_KEY'] = freshOperatorKey();
  process.env['HEDERA_NETWORK'] = 'testnet';
  process.env['HEDERA_ENV_LABEL'] = 'dev';
  process.env['HEDERA_MIRROR_NODE_URL'] = 'https://testnet.mirrornode.hedera.com';
  process.env['HEDERA_HASHSCAN_BASE_URL'] = 'https://hashscan.io';
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
    setValidBootstrapEnv();
    delete process.env['HEDERA_OPERATOR_ID'];
    expect(() => loadBootstrapEnv()).toThrow(/HEDERA_OPERATOR_ID/);
  });

  it('throws when HEDERA_OPERATOR_KEY is missing', () => {
    setValidBootstrapEnv();
    delete process.env['HEDERA_OPERATOR_KEY'];
    expect(() => loadBootstrapEnv()).toThrow(/HEDERA_OPERATOR_KEY/);
  });

  it('throws when HEDERA_OPERATOR_KEY is malformed (fail-loud before any network call)', () => {
    setValidBootstrapEnv();
    process.env['HEDERA_OPERATOR_KEY'] = 'not-a-valid-hex-key';
    expect(() => loadBootstrapEnv()).toThrow(/valid ECDSA private key/);
  });

  it('throws when HEDERA_NETWORK is missing', () => {
    setValidBootstrapEnv();
    delete process.env['HEDERA_NETWORK'];
    expect(() => loadBootstrapEnv()).toThrow(/HEDERA_NETWORK/);
  });

  it('throws when HEDERA_NETWORK is an unknown value (e.g. "previewnet")', () => {
    setValidBootstrapEnv();
    process.env['HEDERA_NETWORK'] = 'previewnet';
    expect(() => loadBootstrapEnv()).toThrow(/testnet.*mainnet/);
  });

  it('throws when HEDERA_ENV_LABEL is missing', () => {
    setValidBootstrapEnv();
    delete process.env['HEDERA_ENV_LABEL'];
    expect(() => loadBootstrapEnv()).toThrow(/HEDERA_ENV_LABEL/);
  });

  it('throws when HEDERA_MIRROR_NODE_URL is missing (fail-fast, no default)', () => {
    setValidBootstrapEnv();
    delete process.env['HEDERA_MIRROR_NODE_URL'];
    expect(() => loadBootstrapEnv()).toThrow(/HEDERA_MIRROR_NODE_URL/);
  });

  it('throws when HEDERA_HASHSCAN_BASE_URL is missing (fail-fast, no default)', () => {
    setValidBootstrapEnv();
    delete process.env['HEDERA_HASHSCAN_BASE_URL'];
    expect(() => loadBootstrapEnv()).toThrow(/HEDERA_HASHSCAN_BASE_URL/);
  });

  it('throws when HEDERA_MIRROR_NODE_URL is whitespace-only', () => {
    setValidBootstrapEnv();
    process.env['HEDERA_MIRROR_NODE_URL'] = '   ';
    expect(() => loadBootstrapEnv()).toThrow(/HEDERA_MIRROR_NODE_URL/);
  });

  it('loads successfully with valid env (happy path) including URLs', () => {
    const key = freshOperatorKey();
    setValidBootstrapEnv();
    process.env['HEDERA_OPERATOR_KEY'] = key;
    process.env['HEDERA_ENV_LABEL'] = 'testnet-uat';
    process.env['HEDERA_MIRROR_NODE_URL'] = 'https://mirror.example.test';
    process.env['HEDERA_HASHSCAN_BASE_URL'] = 'https://hashscan.example.test';

    const env = loadBootstrapEnv();
    expect(env.operatorId).toBe('0.0.1001');
    expect(env.network).toBe('testnet');
    expect(env.envLabel).toBe('testnet-uat');
    expect(env.operatorKey).toBeInstanceOf(PrivateKey);
    expect(env.operatorKey.toStringRaw()).toBe(key);
    expect(env.mirrorNodeUrl).toBe('https://mirror.example.test');
    expect(env.hashscanBaseUrl).toBe('https://hashscan.example.test');
  });

  it('accepts mainnet as a valid network', () => {
    setValidBootstrapEnv();
    process.env['HEDERA_NETWORK'] = 'mainnet';
    process.env['HEDERA_ENV_LABEL'] = 'mainnet-prod';
    expect(() => loadBootstrapEnv()).not.toThrow();
    expect(loadBootstrapEnv().network).toBe('mainnet');
  });

  it('rejects empty-string values (same as missing)', () => {
    setValidBootstrapEnv();
    process.env['HEDERA_OPERATOR_ID'] = '   ';
    expect(() => loadBootstrapEnv()).toThrow(/HEDERA_OPERATOR_ID/);
  });
});
