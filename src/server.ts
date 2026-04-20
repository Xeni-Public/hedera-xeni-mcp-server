// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * Server bootstrap — wires HederaMCPToolkit with a single agent client +
 * upstream core plugins. Called from both transports/stdio.ts and
 * transports/http.ts.
 *
 * Post-pivot (see docs/DESIGN.md §6): no Xeni-custom plugins, no hooks,
 * no policies, no fee calculator. Upstream core plugins are registered
 * explicitly (ToolDiscovery defaults to `[]` with no plugins passed, so
 * we MUST name the core set ourselves).
 */

import { AgentMode } from '@hashgraph/hedera-agent-kit';
import { allCorePlugins } from '@hashgraph/hedera-agent-kit/plugins';
import { HederaMCPToolkit } from '@hashgraph/hedera-agent-kit-mcp';
import { Client, PrivateKey } from '@hiero-ledger/sdk';
import { loadAgentAccount, loadTreasuryAccountId } from './accounts.js';
import { xeniReadPlugin } from './plugins/xeniRead/index.js';
import { log } from './logger.js';

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
 * Build the HederaMCPToolkit instance. Transport-agnostic — callers
 * (`transports/stdio.ts`, `transports/http.ts`) connect the returned
 * toolkit to their chosen transport via `toolkit.connect(transport)`.
 *
 * Registers all upstream core plugins explicitly. Upstream's
 * `ToolDiscovery.createFromConfiguration` treats `configuration.plugins`
 * as `|| []`, so without this list we'd expose zero tools.
 *
 * Default `AgentMode.AUTONOMOUS` — the server signs every tool
 * transaction with the agent key. RETURN_BYTES mode is not exposed
 * here; user-signed flows (e.g. User A granting an allowance to the
 * agent) are handled by AgentService constructing transaction bytes
 * directly via `@hashgraph/sdk-go`, not through this MCP.
 */
export function buildToolkit(config: ServerConfig): HederaMCPToolkit {
  const agent = loadAgentAccount();
  const treasuryAccountId = loadTreasuryAccountId();

  // Parse + validate the key at boot — fail loud if malformed.
  const agentPrivateKey = PrivateKey.fromStringECDSA(agent.privateKey);

  const client = Client.forName(config.network).setOperator(agent.accountId, agentPrivateKey);

  log.info('Hedera client initialized', {
    network: config.network,
    envLabel: config.envLabel,
    agentAccountId: agent.accountId,
    treasuryAccountId,
  });

  // Compose upstream core plugins with the Xeni-owned read plugin.
  // `xeniReadPlugin` carries NO Xeni business logic — just thin read-only
  // wrappers (currently `get_treasury_allowance_remaining`) that give
  // AgentService a single integration surface instead of talking to
  // Mirror Node directly. See docs/DESIGN.md §6 for the policy.
  const plugins = [
    ...allCorePlugins,
    xeniReadPlugin({
      getTreasuryAllowanceRemaining: {
        treasuryAccountId,
        agentAccountId: agent.accountId,
        network: config.network,
      },
    }),
  ];

  const toolkit = new HederaMCPToolkit({
    client,
    configuration: {
      plugins,
      context: {
        mode: AgentMode.AUTONOMOUS,
        accountId: agent.accountId,
      },
    },
  });

  log.info('HederaMCPToolkit ready', {
    mode: 'AUTONOMOUS',
    corePluginCount: allCorePlugins.length,
    xeniReadPlugin: true,
    totalPluginCount: plugins.length,
  });

  return toolkit;
}
