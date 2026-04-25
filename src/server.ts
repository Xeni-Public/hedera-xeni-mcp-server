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
  /** Mirror Node base URL — required at startup; no hardcoded default. */
  mirrorNodeUrl: string;
  /** HashScan explorer root — required at startup; no hardcoded default. */
  hashscanBaseUrl: string;
}

/**
 * Fail-loud env-var read. Throws with a clear message pointing at
 * `.env.example` so ops sees the specific missing variable rather than
 * falling back to a silent default that could mask a dev-vs-prod
 * misconfig. See docs/DESIGN.md §3 "External URLs — required env,
 * fail-fast" for why there are no defaults on the URL vars.
 */
function requireRuntimeEnv(name: string): string {
  const val = process.env[name];
  if (!val || val.trim() === '') {
    throw new Error(
      `Required env var missing: ${name}. See .env.example SECTION A for runtime-required vars.`,
    );
  }
  return val.trim();
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
    // Both URLs are REQUIRED at startup in every env (dev, testnet-ci,
    // testnet-uat, mainnet-prod). There's no hardcoded default — a
    // sensible-looking default would let a dev-vs-prod env mismatch hide.
    mirrorNodeUrl: requireRuntimeEnv('HEDERA_MIRROR_NODE_URL'),
    hashscanBaseUrl: requireRuntimeEnv('HEDERA_HASHSCAN_BASE_URL'),
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
        mirrorNodeUrl: config.mirrorNodeUrl,
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
