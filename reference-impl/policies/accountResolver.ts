// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * ⚑ RETIRED post-pivot (2026-04-20). Preserved here as historical design
 * context only. Do NOT port to Go.
 *
 * Why retired: upstream `@hashgraph/hedera-agent-kit-mcp@1.0.0` takes a
 * single `Client` at construction time — the entire MCP server runs under
 * one signing identity (agent). There is no runtime choice of operator
 * vs agent per tool call to resolve. Operator became cold (bootstrap-only)
 * in the pivot; this policy's decision matrix has no runtime consumer.
 *
 * Tests at `reference-impl/tests/accountResolver.test.ts` still run in
 * CI as spec verification, but neither the policy nor its tests shape
 * any Go port. See `docs/HANDOVER_TO_AGENT_SERVICE.md` for what DID
 * port to AgentService.
 *
 * ---
 *
 * accountResolver policy — picks which Hedera Client (operator or agent) to
 * use for a given tool call.
 *
 * See docs/DESIGN.md §6 (plugin surface) and §3 (account model).
 *
 * Decision rules:
 *   - create_topic, submit_message      → operator client (pays HCS fees)
 *   - approve_hbar_allowance (User→Agent) → RETURN_BYTES mode; no client signing
 *   - transfer_hbar_with_allowance       → agent client (spends via approved allowance)
 *   - transfer_hbar                      → agent client by default; operator for ops flows
 *
 * Treasury key is NEVER loaded here — it's cold. Refund allowance grants
 * (treasury→agent) are signed offline by ops, not by this server.
 */

import type { AccountRegistry, Role } from '../../../accounts.js';

export type ToolName =
  | 'create_topic'
  | 'submit_message'
  | 'approve_hbar_allowance'
  | 'transfer_hbar_with_allowance'
  | 'transfer_hbar';

export interface AccountResolverInput {
  tool: ToolName;
  /** Some callers override the default mapping (e.g. ops refund flow using operator). */
  overrideRole?: Role;
}

export function resolveRole(input: AccountResolverInput, _registry: AccountRegistry): Role {
  if (input.overrideRole) return input.overrideRole;

  switch (input.tool) {
    case 'create_topic':
    case 'submit_message':
      return 'operator';
    case 'approve_hbar_allowance':
      // User-signed via wallet (RETURN_BYTES). Server doesn't sign.
      // Return agent so the resolved Client knows which spender to name in params.
      return 'agent';
    case 'transfer_hbar_with_allowance':
      return 'agent';
    case 'transfer_hbar':
      return 'agent';
    default: {
      const exhaustive: never = input.tool;
      throw new Error(`Unknown tool in accountResolver: ${String(exhaustive)}`);
    }
  }
}
