// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * Server bootstrap — wires HederaMCPToolkit with a single agent client.
 * Called from both transports/stdio.ts and transports/http.ts.
 *
 * Post-pivot (2026-04-20): no custom plugins, no hooks, no policies, no
 * fee calculator. Upstream tools are exposed as-is via the toolkit. See
 * docs/DESIGN.md §6 (plugin surface is empty), §7 (no private logic),
 * §8 (transport rules).
 */

import { loadAgentAccount } from './accounts.js';
import { log } from './logger.js';

// TODO (PR #10): import HederaMCPToolkit from '@hashgraph/hedera-agent-kit-mcp'
// TODO (PR #10): import Client from '@hiero-ledger/sdk'

export interface ServerConfig {
  network: 'testnet' | 'mainnet';
  transport: 'stdio' | 'http';
  httpBind: string;
  httpPort: number;
  nodeEnv: 'development' | 'test' | 'production';
  envLabel: string;
}

export function loadConfig(): ServerConfig {
  const nodeEnv = (process.env['NODE_ENV'] ?? 'development') as ServerConfig['nodeEnv'];
  const transport = (process.env['HEDERA_TRANSPORT'] ?? 'stdio') as ServerConfig['transport'];

  // Security rule (docs/DESIGN.md §8): HTTP transport is forbidden in production.
  if (nodeEnv === 'production' && transport === 'http') {
    log.error('HTTP transport is not permitted in production. Use stdio.');
    process.exit(1);
  }

  return {
    network: (process.env['HEDERA_NETWORK'] ?? 'testnet') as ServerConfig['network'],
    transport,
    httpBind: process.env['HEDERA_HTTP_BIND'] ?? '127.0.0.1',
    httpPort: Number(process.env['HEDERA_HTTP_PORT'] ?? '7701'),
    nodeEnv,
    envLabel: process.env['HEDERA_ENV_LABEL'] ?? 'dev',
  };
}

/**
 * Build the HederaMCPToolkit instance. Transport-agnostic.
 *
 * Post-pivot implementation (wiring lands in PR #10):
 *   1. Load agent account from env.
 *   2. Construct a single `Client` with agent as operator on the configured network.
 *   3. Instantiate `HederaMCPToolkit({ client, configuration })` — upstream
 *      auto-registers every tool from its built-in plugins.
 *   4. Return the toolkit so the transport can connect it.
 *
 * No custom plugin injection. No hooks. No policies. Upstream tools only.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- skeleton; await lands when upstream Client + HederaMCPToolkit are imported in PR #10.
export async function buildToolkit(config: ServerConfig): Promise<unknown> {
  const agent = loadAgentAccount();

  log.info('Loaded runtime agent account', {
    accountId: agent.accountId,
    network: config.network,
    envLabel: config.envLabel,
  });

  // TODO (PR #10): const client = Client.forName(config.network).setOperator(agent.accountId, agent.privateKey);
  // TODO (PR #10): const toolkit = new HederaMCPToolkit({ client, configuration: { /* defaults */ } });
  // TODO (PR #10): return toolkit;

  throw new Error('buildToolkit: scaffold skeleton; upstream wiring lands in PR #10');
}
