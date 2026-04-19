/**
 * stdio transport — default; AgentService spawns the server as a child process.
 *
 * See docs/DESIGN.md §8.
 */

import { buildToolkit, loadConfig } from '../server.js';
import { log } from '../logger.js';

async function main(): Promise<void> {
  const config = loadConfig();
  log.info('Starting hedera-xeni-mcp-server (stdio)', {
    network: config.network,
    nodeEnv: config.nodeEnv,
  });

  // Exercise buildToolkit so its env-parsing + fail-open/closed checks run.
  // Toolkit instance intentionally not retained — implementation PR captures
  // it and connects to StdioServerTransport.
  await buildToolkit(config);

  // TODO: connect the toolkit to StdioServerTransport from @modelcontextprotocol/sdk
  // TODO: handle SIGTERM / SIGINT for clean shutdown (flush pending log lines,
  //   disconnect transport, exit 0)
  throw new Error('stdio transport: scaffold skeleton; implementation lands in next PR');
}

main().catch((err: unknown) => {
  log.error('stdio transport failed to start', { error: String(err) });
  process.exit(1);
});
