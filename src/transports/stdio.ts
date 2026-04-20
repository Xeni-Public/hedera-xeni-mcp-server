// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * stdio transport — default; AgentService spawns the server as a child process.
 *
 * See docs/DESIGN.md §8.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { HederaMCPToolkit } from '@hashgraph/hedera-agent-kit-mcp';
import { buildToolkit, loadConfig } from '../server.js';
import { log } from '../logger.js';

async function main(): Promise<void> {
  const config = loadConfig();
  log.info('Starting hedera-xeni-mcp-server (stdio)', {
    network: config.network,
    nodeEnv: config.nodeEnv,
    envLabel: config.envLabel,
  });

  const toolkit: HederaMCPToolkit = buildToolkit(config);
  const transport = new StdioServerTransport();

  await toolkit.connect(transport);
  log.info('stdio transport connected; ready for MCP traffic');

  // Graceful shutdown on SIGTERM / SIGINT so the parent (AgentService) gets
  // a clean exit when it tears down the child process.
  const shutdown = async (signal: string): Promise<void> => {
    log.info(`received ${signal}; shutting down`);
    try {
      await toolkit.close();
      log.info('stdio transport closed');
    } catch (err) {
      log.error('error during toolkit close', { error: String(err) });
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
}

main().catch((err: unknown) => {
  log.error('stdio transport failed to start', { error: String(err) });
  process.exit(1);
});
