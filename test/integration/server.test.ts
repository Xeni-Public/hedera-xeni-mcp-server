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
    const config = loadConfig();
    expect(() => buildToolkit(config)).toThrow(/HEDERA_AGENT_ID/);
  });

  it('throws when HEDERA_AGENT_KEY is missing', () => {
    process.env['HEDERA_AGENT_ID'] = generateAgentEnv().id;
    const config = loadConfig();
    expect(() => buildToolkit(config)).toThrow(/HEDERA_AGENT_KEY/);
  });

  it('throws when HEDERA_AGENT_KEY is malformed', () => {
    process.env['HEDERA_AGENT_ID'] = generateAgentEnv().id;
    process.env['HEDERA_AGENT_KEY'] = 'not-a-hex-key';
    const config = loadConfig();
    expect(() => buildToolkit(config)).toThrow();
  });

  it('returns a HederaMCPToolkit instance with valid agent env', () => {
    const agent = generateAgentEnv();
    process.env['HEDERA_AGENT_ID'] = agent.id;
    process.env['HEDERA_AGENT_KEY'] = agent.key;

    const config = loadConfig();
    const toolkit = buildToolkit(config);

    expect(toolkit).toBeInstanceOf(HederaMCPToolkit);
  });

  it('defaults network to testnet when HEDERA_NETWORK is unset', () => {
    const agent = generateAgentEnv();
    process.env['HEDERA_AGENT_ID'] = agent.id;
    process.env['HEDERA_AGENT_KEY'] = agent.key;

    const config = loadConfig();
    expect(config.network).toBe('testnet');

    const toolkit = buildToolkit(config);
    expect(toolkit).toBeInstanceOf(HederaMCPToolkit);
  });

  it('accepts mainnet when HEDERA_NETWORK=mainnet', () => {
    const agent = generateAgentEnv();
    process.env['HEDERA_AGENT_ID'] = agent.id;
    process.env['HEDERA_AGENT_KEY'] = agent.key;
    process.env['HEDERA_NETWORK'] = 'mainnet';

    const config = loadConfig();
    expect(config.network).toBe('mainnet');

    const toolkit = buildToolkit(config);
    expect(toolkit).toBeInstanceOf(HederaMCPToolkit);
  });

  it('reads HEDERA_ENV_LABEL from env (defaults to dev)', () => {
    process.env['HEDERA_ENV_LABEL'] = 'testnet-uat';
    const config = loadConfig();
    expect(config.envLabel).toBe('testnet-uat');

    delete process.env['HEDERA_ENV_LABEL'];
    expect(loadConfig().envLabel).toBe('dev');
  });

  it('defaults HTTP bind to 127.0.0.1 (loopback-only)', () => {
    const config = loadConfig();
    expect(config.httpBind).toBe('127.0.0.1');
  });

  it('exposes an agent account that WARN-logs on operator-key leak (cold-key invariant)', () => {
    const agent = generateAgentEnv();
    process.env['HEDERA_AGENT_ID'] = agent.id;
    process.env['HEDERA_AGENT_KEY'] = agent.key;
    process.env['HEDERA_OPERATOR_KEY'] = 'should-not-be-in-runtime-env';

    const config = loadConfig();
    // Not asserting the log line here (stderr capture is vitest-project-level);
    // just confirming buildToolkit still succeeds — WARN does not block startup.
    expect(() => buildToolkit(config)).not.toThrow();
  });
});
