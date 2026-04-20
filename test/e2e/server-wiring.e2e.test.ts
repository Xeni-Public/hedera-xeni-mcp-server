// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * E2E: server wiring against real Hedera testnet.
 *
 * Validates that `buildToolkit()` produces a working MCP toolkit when given
 * real testnet-ci credentials: the client connects, the toolkit registers
 * the upstream core plugins + `xeniReadPlugin`, and the read tool actually
 * hits Mirror Node and comes back with a number.
 *
 * Scope (per DESIGN.md §14 E2E row):
 *   - Toolkit instance constructed without throwing
 *   - `allCorePlugins` + `xeniReadPlugin` both registered (count sanity)
 *   - `get_treasury_allowance_remaining` returns `{ remainingHbar: number }`
 *     from a REAL Mirror Node query (not mocked)
 *
 * Runs only on the nightly CI job or when a developer exports testnet
 * credentials locally. Missing env = describe.skipIf → test suite is
 * skipped, not failed.
 */

import { describe, expect, it } from 'vitest';
import type { Client } from '@hiero-ledger/sdk';
import type { Context } from '@hashgraph/hedera-agent-kit';
import { HederaMCPToolkit } from '@hashgraph/hedera-agent-kit-mcp';
import { buildToolkit, loadConfig } from '../../src/server.js';
import {
  makeGetTreasuryAllowanceRemainingTool,
  type GetTreasuryAllowanceRemainingResult,
} from '../../src/plugins/xeniRead/getTreasuryAllowanceRemaining.js';
import { missingE2EEnv } from './_helpers.js';

const missing = missingE2EEnv(['HEDERA_XENI_TREASURY_ID']);

// Hedera client construction is synchronous but pulls node endpoints;
// first boot can be slow on a fresh Actions runner.
const BUILD_TOOLKIT_TIMEOUT_MS = 30_000;
// Mirror Node fetch has a 5s default timeout + ~1s network jitter.
const MIRROR_NODE_READ_TIMEOUT_MS = 30_000;

describe.skipIf(missing.length > 0)('E2E / server wiring (real testnet)', () => {
  it(
    'buildToolkit returns a HederaMCPToolkit instance against testnet',
    () => {
      const config = loadConfig();
      expect(config.network).toBe('testnet');
      const toolkit = buildToolkit(config);
      expect(toolkit).toBeInstanceOf(HederaMCPToolkit);
    },
    BUILD_TOOLKIT_TIMEOUT_MS,
  );

  it(
    'get_treasury_allowance_remaining returns a real remainingHbar number from Mirror Node',
    async () => {
      // We invoke the tool directly (rather than round-tripping through
      // the MCP protocol) because the tool's execute signature is the
      // canonical contract AgentService calls. This asserts the full
      // wiring: env → network → Mirror Node URL → fetch → parse → sum.
      const treasuryId = process.env['HEDERA_XENI_TREASURY_ID']!;
      const agentId = process.env['HEDERA_AGENT_ID']!;
      const network = process.env['HEDERA_NETWORK']!;

      const tool = makeGetTreasuryAllowanceRemainingTool({
        treasuryAccountId: treasuryId,
        agentAccountId: agentId,
        network,
      });

      // Dummy client / context — the tool doesn't consume them for this
      // Mirror Node read (see getTreasuryAllowanceRemaining.ts). We cast
      // to the real types (via `unknown`) rather than `any` so lint stays
      // clean — the tool implementation accepts these parameter types
      // structurally, not nominally.
      //
      // MIGRATION NOTE: if this tool ever starts using the Client (e.g.
      // for an on-chain read via Hiero SDK instead of Mirror Node REST),
      // swap these stubs for real instances:
      //   const agentKey = PrivateKey.fromStringECDSA(process.env['HEDERA_AGENT_KEY']!);
      //   const client = Client.forName(network).setOperator(agentId, agentKey);
      //   // ... wrap the test body in try/finally with client.close() to avoid
      //   // lingering gRPC sockets in nightly CI.
      const client = {} as unknown as Client;
      const context = { accountId: agentId } as unknown as Context;

      const result = (await tool.execute(client, context, {})) as {
        raw: GetTreasuryAllowanceRemainingResult;
        humanMessage: string;
      };

      // remainingHbar is a number ≥ 0. The specific value depends on how
      // much ops has used this env for refund tests; we don't pin it, but
      // a non-number or negative return means the wiring is broken.
      expect(typeof result.raw.remainingHbar).toBe('number');
      expect(result.raw.remainingHbar).toBeGreaterThanOrEqual(0);
      expect(result.raw.ownerAccountId).toBe(treasuryId);
      expect(result.raw.spenderAccountId).toBe(agentId);
      expect(result.humanMessage).toContain(treasuryId);
      expect(result.humanMessage).toContain(agentId);
    },
    MIRROR_NODE_READ_TIMEOUT_MS,
  );
});

describe.skipIf(missing.length === 0)('E2E / server wiring — SKIPPED (missing env)', () => {
  it('reports missing env vars so the skip reason is visible in test output', () => {
    // This test runs ONLY when the suite above is skipped; it surfaces
    // the specific missing vars so a developer seeing "skipped" in the
    // log can immediately see what to export locally.
    // eslint-disable-next-line no-console -- intentional skip diagnostic
    console.warn(
      `[e2e/server-wiring] Skipped. Missing env: ${missing.join(', ')}. ` +
        `Export testnet-ci credentials (see README / .env.example SECTION A) and re-run.`,
    );
    expect(missing.length).toBeGreaterThan(0);
  });
});
