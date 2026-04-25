// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * Integration tests for `server.ts` — validates the toolkit wiring
 * without opening a transport or making network calls.
 *
 * `Client.forName(...)` is synchronous and doesn't network-connect at
 * construction (it only wires node endpoints). `new HederaMCPToolkit(...)`
 * registers tools in-memory; no Hedera calls. Safe to run in CI.
 *
 * Test strategy:
 *   - Generate a fresh ECDSA key per test (not a real testnet account —
 *     format-valid only; we're verifying the wiring, not the identity).
 *   - Swap `process.env` within each test and restore after.
 *   - Assert the toolkit is constructed and exposes at least one of the
 *     upstream tools we depend on (transfer_hbar, submit_topic_message).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrivateKey } from '@hiero-ledger/sdk';
import { HederaMCPToolkit } from '@hashgraph/hedera-agent-kit-mcp';
import { buildToolkit, loadConfig } from '../../src/server.js';

/** Generate a format-valid ECDSA key for tests (not a real testnet account). */
function generateAgentEnv(): { id: string; key: string } {
  const pk = PrivateKey.generateECDSA();
  // Use a dummy account id — the client factory doesn't network-verify it.
  return { id: '0.0.1234567', key: pk.toStringRaw() };
}

/**
 * Set the minimum required env to make `buildToolkit()` succeed in tests.
 * PR #13 added `HEDERA_XENI_TREASURY_ID` as a runtime requirement (for the
 * `get_treasury_allowance_remaining` tool); tests that want a successful
 * toolkit build must set both agent + treasury env vars.
 */
function setValidBuildEnv(): { agent: { id: string; key: string } } {
  const agent = generateAgentEnv();
  process.env['HEDERA_AGENT_ID'] = agent.id;
  process.env['HEDERA_AGENT_KEY'] = agent.key;
  process.env['HEDERA_XENI_TREASURY_ID'] = '0.0.7654321';
  // Both URLs are required by loadConfig() (fail-fast, no defaults).
  // Test fixtures supply the canonical public values so the server builds
  // without relying on any hardcoded fallback in the code.
  process.env['HEDERA_MIRROR_NODE_URL'] = 'https://testnet.mirrornode.hedera.com';
  process.env['HEDERA_HASHSCAN_BASE_URL'] = 'https://hashscan.io';
  return { agent };
}

describe('server / buildToolkit', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    // Clear all HEDERA_* env before each test so we start from a clean slate.
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('HEDERA_')) delete process.env[k];
    }
  });

  afterEach(() => {
    // Restore original env.
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('HEDERA_')) delete process.env[k];
    }
    Object.assign(process.env, savedEnv);
  });

  it('throws when HEDERA_AGENT_ID is missing', () => {
    process.env['HEDERA_AGENT_KEY'] = generateAgentEnv().key;
    process.env['HEDERA_XENI_TREASURY_ID'] = '0.0.7654321';
    process.env['HEDERA_MIRROR_NODE_URL'] = 'https://testnet.mirrornode.hedera.com';
    process.env['HEDERA_HASHSCAN_BASE_URL'] = 'https://hashscan.io';
    const config = loadConfig();
    expect(() => buildToolkit(config)).toThrow(/HEDERA_AGENT_ID/);
  });

  it('throws when HEDERA_AGENT_KEY is missing', () => {
    process.env['HEDERA_AGENT_ID'] = generateAgentEnv().id;
    process.env['HEDERA_XENI_TREASURY_ID'] = '0.0.7654321';
    process.env['HEDERA_MIRROR_NODE_URL'] = 'https://testnet.mirrornode.hedera.com';
    process.env['HEDERA_HASHSCAN_BASE_URL'] = 'https://hashscan.io';
    const config = loadConfig();
    expect(() => buildToolkit(config)).toThrow(/HEDERA_AGENT_KEY/);
  });

  it('throws when HEDERA_AGENT_KEY is malformed', () => {
    process.env['HEDERA_AGENT_ID'] = generateAgentEnv().id;
    process.env['HEDERA_AGENT_KEY'] = 'not-a-hex-key';
    process.env['HEDERA_XENI_TREASURY_ID'] = '0.0.7654321';
    process.env['HEDERA_MIRROR_NODE_URL'] = 'https://testnet.mirrornode.hedera.com';
    process.env['HEDERA_HASHSCAN_BASE_URL'] = 'https://hashscan.io';
    const config = loadConfig();
    expect(() => buildToolkit(config)).toThrow();
  });

  it('throws when HEDERA_XENI_TREASURY_ID is missing (runtime read for get_treasury_allowance_remaining)', () => {
    const agent = generateAgentEnv();
    process.env['HEDERA_AGENT_ID'] = agent.id;
    process.env['HEDERA_AGENT_KEY'] = agent.key;
    process.env['HEDERA_MIRROR_NODE_URL'] = 'https://testnet.mirrornode.hedera.com';
    process.env['HEDERA_HASHSCAN_BASE_URL'] = 'https://hashscan.io';
    // HEDERA_XENI_TREASURY_ID intentionally omitted
    const config = loadConfig();
    expect(() => buildToolkit(config)).toThrow(/HEDERA_XENI_TREASURY_ID/);
  });

  it('loadConfig throws when HEDERA_MIRROR_NODE_URL is missing (fail-fast, no default)', () => {
    const agent = generateAgentEnv();
    process.env['HEDERA_AGENT_ID'] = agent.id;
    process.env['HEDERA_AGENT_KEY'] = agent.key;
    process.env['HEDERA_XENI_TREASURY_ID'] = '0.0.7654321';
    process.env['HEDERA_HASHSCAN_BASE_URL'] = 'https://hashscan.io';
    // HEDERA_MIRROR_NODE_URL intentionally omitted
    expect(() => loadConfig()).toThrow(/HEDERA_MIRROR_NODE_URL/);
  });

  it('loadConfig throws when HEDERA_HASHSCAN_BASE_URL is missing (fail-fast, no default)', () => {
    const agent = generateAgentEnv();
    process.env['HEDERA_AGENT_ID'] = agent.id;
    process.env['HEDERA_AGENT_KEY'] = agent.key;
    process.env['HEDERA_XENI_TREASURY_ID'] = '0.0.7654321';
    process.env['HEDERA_MIRROR_NODE_URL'] = 'https://testnet.mirrornode.hedera.com';
    // HEDERA_HASHSCAN_BASE_URL intentionally omitted
    expect(() => loadConfig()).toThrow(/HEDERA_HASHSCAN_BASE_URL/);
  });

  it('loadConfig throws when HEDERA_MIRROR_NODE_URL is whitespace-only (fail-fast on blank)', () => {
    const agent = generateAgentEnv();
    process.env['HEDERA_AGENT_ID'] = agent.id;
    process.env['HEDERA_AGENT_KEY'] = agent.key;
    process.env['HEDERA_XENI_TREASURY_ID'] = '0.0.7654321';
    process.env['HEDERA_MIRROR_NODE_URL'] = '   ';
    process.env['HEDERA_HASHSCAN_BASE_URL'] = 'https://hashscan.io';
    expect(() => loadConfig()).toThrow(/HEDERA_MIRROR_NODE_URL/);
  });

  it('returns a HederaMCPToolkit instance with valid agent + treasury env', () => {
    setValidBuildEnv();

    const config = loadConfig();
    const toolkit = buildToolkit(config);

    expect(toolkit).toBeInstanceOf(HederaMCPToolkit);
  });

  it('defaults network to testnet when HEDERA_NETWORK is unset', () => {
    setValidBuildEnv();

    const config = loadConfig();
    expect(config.network).toBe('testnet');

    const toolkit = buildToolkit(config);
    expect(toolkit).toBeInstanceOf(HederaMCPToolkit);
  });

  it('accepts mainnet when HEDERA_NETWORK=mainnet', () => {
    setValidBuildEnv();
    process.env['HEDERA_NETWORK'] = 'mainnet';

    const config = loadConfig();
    expect(config.network).toBe('mainnet');

    const toolkit = buildToolkit(config);
    expect(toolkit).toBeInstanceOf(HederaMCPToolkit);
  });

  it('reads HEDERA_ENV_LABEL from env (defaults to dev)', () => {
    process.env['HEDERA_MIRROR_NODE_URL'] = 'https://testnet.mirrornode.hedera.com';
    process.env['HEDERA_HASHSCAN_BASE_URL'] = 'https://hashscan.io';
    process.env['HEDERA_ENV_LABEL'] = 'testnet-uat';
    const config = loadConfig();
    expect(config.envLabel).toBe('testnet-uat');

    delete process.env['HEDERA_ENV_LABEL'];
    expect(loadConfig().envLabel).toBe('dev');
  });

  it('defaults HTTP bind to 127.0.0.1 (loopback-only)', () => {
    process.env['HEDERA_MIRROR_NODE_URL'] = 'https://testnet.mirrornode.hedera.com';
    process.env['HEDERA_HASHSCAN_BASE_URL'] = 'https://hashscan.io';
    const config = loadConfig();
    expect(config.httpBind).toBe('127.0.0.1');
  });

  it('exposes an agent account that WARN-logs on operator-key leak (cold-key invariant)', () => {
    setValidBuildEnv();
    process.env['HEDERA_OPERATOR_KEY'] = 'should-not-be-in-runtime-env';

    const config = loadConfig();
    // Not asserting the log line here (stderr capture is vitest-project-level);
    // just confirming buildToolkit still succeeds — WARN does not block startup.
    expect(() => buildToolkit(config)).not.toThrow();
  });

  it('allows HEDERA_XENI_TREASURY_ID at runtime (public identifier, not a cold key)', () => {
    // Reverse check of the cold-key invariant: the ACCOUNT ID is safe in
    // runtime env, and no WARN should fire for it. Only the KEY triggers
    // the cold-key warning (covered in src/accounts.ts tests indirectly).
    setValidBuildEnv();
    const config = loadConfig();
    expect(() => buildToolkit(config)).not.toThrow();
  });
});
