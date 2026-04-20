// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * `xeniReadPlugin` — container for Xeni-owned READ-ONLY MCP tools.
 *
 * Passed to `HederaMCPToolkit` alongside `allCorePlugins`. All tools here
 * are thin wrappers around public Hedera state (Mirror Node REST, on-chain
 * reads). They carry NO Xeni business logic — any Xeni guards / policies /
 * hooks still live AgentService-side per the Option D pivot
 * (docs/DESIGN.md §6).
 *
 * Why a plugin and not inline `toolkit.tool(...)` calls: a plugin is the
 * canonical extension seam upstream exposes, and it gives us a container
 * to grow (future: `get_audit_topic_latest_sequence` for HashScan
 * verification, `get_agent_balance` for treasury alerting) without
 * retro-restructuring `buildToolkit`.
 *
 * Consumer: `src/server.ts` `buildToolkit()`.
 */

import type { Context, Plugin, Tool } from '@hashgraph/hedera-agent-kit';
import {
  makeGetTreasuryAllowanceRemainingTool,
  type GetTreasuryAllowanceRemainingDeps,
} from './getTreasuryAllowanceRemaining.js';

/**
 * Dependency bag for all Xeni read tools. Each sub-tool's deps are nested
 * under its own key so the registration site in `server.ts` reads like a
 * tool-by-tool config.
 */
export interface XeniReadPluginDeps {
  getTreasuryAllowanceRemaining: GetTreasuryAllowanceRemainingDeps;
}

/**
 * Build the Xeni-owned read plugin with the supplied deps. Deps are bound
 * at factory time (toolkit construction) so `tools(context)` can stay
 * context-only — matches the upstream Plugin contract.
 */
export function xeniReadPlugin(deps: XeniReadPluginDeps): Plugin {
  return {
    name: 'xeni_read',
    version: '1.0.0',
    description:
      'Xeni-owned read-only MCP tools. Thin wrappers around public Hedera state (Mirror Node, on-chain reads) so AgentService has a single integration surface. No Xeni business logic.',
    tools: (_context: Context): Tool[] => [
      makeGetTreasuryAllowanceRemainingTool(deps.getTreasuryAllowanceRemaining),
    ],
  };
}

export { GET_TREASURY_ALLOWANCE_REMAINING_TOOL } from './getTreasuryAllowanceRemaining.js';
export type {
  GetTreasuryAllowanceRemainingDeps,
  GetTreasuryAllowanceRemainingResult,
} from './getTreasuryAllowanceRemaining.js';
