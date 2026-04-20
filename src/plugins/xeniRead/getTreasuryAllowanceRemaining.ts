// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * `get_treasury_allowance_remaining` — read-only MCP tool.
 *
 * Returns how much HBAR the Xeni treasury has granted the agent and how
 * much of that grant remains unspent (i.e. how much the agent can still
 * pull for refunds before the daily cap resets). Pure read — queries
 * Mirror Node REST, no on-chain transaction. No Xeni business logic:
 * this is a thin wrapper so AgentService doesn't need to talk to Mirror
 * Node directly (Option D: single gateway to Hedera).
 *
 * Consumer: AgentService's `treasuryAllowanceGuard` injected
 * `queryRemainingAllowanceHbar` dep. See
 * docs/HANDOVER_TO_AGENT_SERVICE.md.
 *
 * Fails loud on Mirror Node errors so the caller can fail closed.
 */

import { z } from 'zod';
import type { Client } from '@hiero-ledger/sdk';
import type { Context, Tool } from '@hashgraph/hedera-agent-kit';
import { log } from '../../logger.js';
import { fetchCryptoAllowances, sumRemainingTinybar, type FetchFn } from './mirrorNode.js';

export const GET_TREASURY_ALLOWANCE_REMAINING_TOOL = 'get_treasury_allowance_remaining';

/**
 * Config bound to the tool at registration time. Kept here (not re-read
 * from env on every call) so the tool is pure + testable with no
 * process.env coupling inside `execute`.
 */
export interface GetTreasuryAllowanceRemainingDeps {
  /** Treasury account that GRANTED the allowance (owner). */
  treasuryAccountId: string;
  /** Agent account RECEIVING the allowance (spender). */
  agentAccountId: string;
  /** Hedera network — selects Mirror Node base URL. */
  network: string;
  /** Optional fetch override for tests. */
  fetchImpl?: FetchFn;
  /** Optional timeout override (ms). Default 5000. */
  timeoutMs?: number;
  /** Optional base URL override (rarely needed; tests use mock). */
  baseUrl?: string;
}

/**
 * Raw structured result of a successful call. Shape is stable — AgentService
 * maps `remainingHbar` to its guard interface. Extra fields are defensive
 * observability aids (who granted to whom, for log correlation).
 */
export interface GetTreasuryAllowanceRemainingResult {
  remainingHbar: number;
  ownerAccountId: string;
  spenderAccountId: string;
}

const inputSchema = z.object({}).strict();

/**
 * Build the `get_treasury_allowance_remaining` Tool. Called by
 * `xeniReadPlugin` at toolkit-construction time; the returned Tool closes
 * over `deps` so no env reads happen at execution time.
 */
export function makeGetTreasuryAllowanceRemainingTool(
  deps: GetTreasuryAllowanceRemainingDeps,
): Tool {
  return {
    method: GET_TREASURY_ALLOWANCE_REMAINING_TOOL,
    name: 'Get Treasury Allowance Remaining',
    description:
      'Returns the remaining HBAR allowance that the Xeni treasury has granted the agent account — i.e. how much HBAR the agent can still pull for refunds before the daily allowance is exhausted. Pure read (no on-chain tx). Input: none. Output: { remainingHbar: number, ownerAccountId: string, spenderAccountId: string }. Precision: HBAR as a JavaScript number is exact up to ~9e15 tinybar (Number.MAX_SAFE_INTEGER = 2^53 - 1), which covers any realistic treasury allowance. Fails loud on Mirror Node errors so callers can fail closed.',
    parameters: inputSchema,
    execute: async (
      _client: Client,
      _context: Context,
      _params: unknown,
    ): Promise<{ raw: GetTreasuryAllowanceRemainingResult; humanMessage: string }> => {
      // Build the narrow options bag. `exactOptionalPropertyTypes: true`
      // means we must spread the optional keys conditionally rather than
      // passing `{ fetchImpl: undefined, ... }`.
      const fetchOpts: Parameters<typeof fetchCryptoAllowances>[3] = {};
      if (deps.fetchImpl) fetchOpts.fetchImpl = deps.fetchImpl;
      if (deps.timeoutMs !== undefined) fetchOpts.timeoutMs = deps.timeoutMs;
      if (deps.baseUrl !== undefined) fetchOpts.baseUrl = deps.baseUrl;

      const res = await fetchCryptoAllowances(
        deps.network,
        deps.treasuryAccountId,
        deps.agentAccountId,
        fetchOpts,
      );

      const remainingTinybar = sumRemainingTinybar(res);
      // 1 HBAR = 10^8 tinybar. Converting BigInt → Number is exact up to
      // Number.MAX_SAFE_INTEGER (2^53 - 1 ≈ 9e15); treasury allowances
      // realistically sit in the 10^10 – 10^14 tinybar range (hundreds
      // to millions of HBAR), well inside safe territory.
      const remainingHbar = Number(remainingTinybar) / 100_000_000;

      log.info('get_treasury_allowance_remaining', {
        owner: deps.treasuryAccountId,
        spender: deps.agentAccountId,
        network: deps.network,
        remainingTinybar: remainingTinybar.toString(),
        remainingHbar,
      });

      return {
        raw: {
          remainingHbar,
          ownerAccountId: deps.treasuryAccountId,
          spenderAccountId: deps.agentAccountId,
        },
        humanMessage: `Treasury ${deps.treasuryAccountId} has ${remainingHbar} HBAR remaining in allowance for agent ${deps.agentAccountId} on ${deps.network}.`,
      };
    },
  };
}
