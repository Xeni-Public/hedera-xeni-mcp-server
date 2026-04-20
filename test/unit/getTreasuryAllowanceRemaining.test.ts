// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * Unit tests for `src/plugins/xeniRead/getTreasuryAllowanceRemaining.ts`.
 *
 * Uses a mock `fetchImpl` injected via `deps.fetchImpl`. No network I/O.
 * Asserts the full tool contract: method name, description, input schema,
 * and the execute-path return shape + humanMessage.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@hiero-ledger/sdk';
import {
  GET_TREASURY_ALLOWANCE_REMAINING_TOOL,
  makeGetTreasuryAllowanceRemainingTool,
  type GetTreasuryAllowanceRemainingResult,
} from '../../src/plugins/xeniRead/getTreasuryAllowanceRemaining.js';
import type { FetchFn } from '../../src/plugins/xeniRead/mirrorNode.js';

function mockFetchReturning(body: unknown, ok = true, status = 200): FetchFn {
  return vi.fn(
    // eslint-disable-next-line @typescript-eslint/require-await -- mock
    async () =>
      ({
        ok,
        status,
        // eslint-disable-next-line @typescript-eslint/require-await -- mock
        json: async () => body,
      }) as unknown as Response,
  );
}

/**
 * Type-safe cast of the `execute` return — the `Tool.execute` signature
 * upstream is `Promise<any>`, so we narrow here so individual tests don't
 * each need their own cast.
 */
type ExecResult = {
  raw: GetTreasuryAllowanceRemainingResult;
  humanMessage: string;
};

// A dummy `Client` cast — the tool doesn't touch the client for Mirror
// Node reads, so `{} as Client` is safe.
const DUMMY_CLIENT = {} as Client;
const DUMMY_CONTEXT = { accountId: '0.0.1002' };

describe('getTreasuryAllowanceRemaining / tool metadata', () => {
  const tool = makeGetTreasuryAllowanceRemainingTool({
    treasuryAccountId: '0.0.1001',
    agentAccountId: '0.0.1002',
    network: 'testnet',
  });

  it('exposes the canonical method name', () => {
    expect(tool.method).toBe(GET_TREASURY_ALLOWANCE_REMAINING_TOOL);
    expect(tool.method).toBe('get_treasury_allowance_remaining');
  });

  it('has a human-readable name', () => {
    expect(tool.name).toMatch(/treasury|allowance/i);
  });

  it('description names the return shape so AgentService can map it', () => {
    expect(tool.description).toContain('remainingHbar');
  });

  it('description calls out the precision bound (2^53)', () => {
    expect(tool.description).toContain('2^53');
  });

  it('description names the fails-loud semantics', () => {
    expect(tool.description.toLowerCase()).toContain('fails loud');
  });

  it('input schema accepts an empty object', () => {
    expect(tool.parameters.parse({})).toEqual({});
  });

  it('input schema rejects extra properties (strict mode)', () => {
    expect(() => tool.parameters.parse({ unexpected: 'value' })).toThrow();
  });
});

describe('getTreasuryAllowanceRemaining / execute', () => {
  it('returns { remainingHbar: 0 } when there are no allowances yet', async () => {
    const fetchImpl = mockFetchReturning({ allowances: [], links: { next: null } });
    const tool = makeGetTreasuryAllowanceRemainingTool({
      treasuryAccountId: '0.0.1001',
      agentAccountId: '0.0.1002',
      network: 'testnet',
      fetchImpl,
    });
    const result = (await tool.execute(DUMMY_CLIENT, DUMMY_CONTEXT, {})) as ExecResult;
    expect(result.raw.remainingHbar).toBe(0);
    expect(result.raw.ownerAccountId).toBe('0.0.1001');
    expect(result.raw.spenderAccountId).toBe('0.0.1002');
  });

  it('converts tinybar → HBAR correctly (100_000_000 tinybar = 1 HBAR)', async () => {
    const fetchImpl = mockFetchReturning({
      allowances: [
        {
          amount: 100_000_000,
          amount_granted: 200_000_000,
          owner: '0.0.1001',
          spender: '0.0.1002',
          timestamp: { from: '1', to: null },
        },
      ],
      links: { next: null },
    });
    const tool = makeGetTreasuryAllowanceRemainingTool({
      treasuryAccountId: '0.0.1001',
      agentAccountId: '0.0.1002',
      network: 'testnet',
      fetchImpl,
    });
    const result = (await tool.execute(DUMMY_CLIENT, DUMMY_CONTEXT, {})) as ExecResult;
    expect(result.raw.remainingHbar).toBe(1);
  });

  it('sums across multiple allowance rows and converts', async () => {
    const fetchImpl = mockFetchReturning({
      allowances: [
        // 500_000_000 tinybar = 5 HBAR
        {
          amount: 500_000_000,
          amount_granted: 1_000_000_000,
          owner: '0.0.1001',
          spender: '0.0.1002',
          timestamp: { from: '1', to: null },
        },
        // 250_000_000 tinybar = 2.5 HBAR
        {
          amount: 250_000_000,
          amount_granted: 500_000_000,
          owner: '0.0.1001',
          spender: '0.0.1002',
          timestamp: { from: '2', to: null },
        },
      ],
      links: { next: null },
    });
    const tool = makeGetTreasuryAllowanceRemainingTool({
      treasuryAccountId: '0.0.1001',
      agentAccountId: '0.0.1002',
      network: 'testnet',
      fetchImpl,
    });
    const result = (await tool.execute(DUMMY_CLIENT, DUMMY_CONTEXT, {})) as ExecResult;
    expect(result.raw.remainingHbar).toBe(7.5);
  });

  it('humanMessage names the owner, spender, and network', async () => {
    const fetchImpl = mockFetchReturning({
      allowances: [
        {
          amount: 500_000_000,
          amount_granted: 1_000_000_000,
          owner: '0.0.1001',
          spender: '0.0.1002',
          timestamp: { from: '1', to: null },
        },
      ],
      links: { next: null },
    });
    const tool = makeGetTreasuryAllowanceRemainingTool({
      treasuryAccountId: '0.0.1001',
      agentAccountId: '0.0.1002',
      network: 'testnet',
      fetchImpl,
    });
    const result = (await tool.execute(DUMMY_CLIENT, DUMMY_CONTEXT, {})) as ExecResult;
    expect(result.humanMessage).toContain('0.0.1001');
    expect(result.humanMessage).toContain('0.0.1002');
    expect(result.humanMessage).toContain('testnet');
    expect(result.humanMessage).toContain('5 HBAR');
  });

  it('propagates Mirror Node errors (fails loud per contract)', async () => {
    const fetchImpl = mockFetchReturning({}, false, 503);
    const tool = makeGetTreasuryAllowanceRemainingTool({
      treasuryAccountId: '0.0.1001',
      agentAccountId: '0.0.1002',
      network: 'testnet',
      fetchImpl,
    });
    await expect(tool.execute(DUMMY_CLIENT, DUMMY_CONTEXT, {})).rejects.toThrow(/HTTP 503/);
  });

  it('propagates "unknown network" error when network is malformed', async () => {
    const tool = makeGetTreasuryAllowanceRemainingTool({
      treasuryAccountId: '0.0.1001',
      agentAccountId: '0.0.1002',
      network: 'previewnet', // not supported
    });
    await expect(tool.execute(DUMMY_CLIENT, DUMMY_CONTEXT, {})).rejects.toThrow(
      /Unknown Hedera network/,
    );
  });

  it('honors custom timeoutMs + baseUrl (proves options bag wires through)', async () => {
    const body = { allowances: [], links: { next: null } };
    const fetchImpl = mockFetchReturning(body);
    const tool = makeGetTreasuryAllowanceRemainingTool({
      treasuryAccountId: '0.0.1001',
      agentAccountId: '0.0.1002',
      network: 'testnet',
      fetchImpl,
      timeoutMs: 1000,
      baseUrl: 'https://mirror-override.example.com',
    });
    await tool.execute(DUMMY_CLIENT, DUMMY_CONTEXT, {});
    const url = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(url).toContain('https://mirror-override.example.com/');
  });
});
