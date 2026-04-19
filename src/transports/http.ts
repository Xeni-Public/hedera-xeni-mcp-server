/**
 * HTTP (StreamableHTTP) transport — dev debug only.
 *
 * Binds to 127.0.0.1 (loopback) by default. See docs/DESIGN.md §8.
 *
 * Hard rule: refuses to start if NODE_ENV=production (loadConfig enforces).
 * Also refuses if HEDERA_HTTP_BIND is set to a non-loopback address without
 * an auth layer (not in v1 scope).
 */

import { buildToolkit, loadConfig } from '../server.js';
import { log } from '../logger.js';

function isLoopback(bind: string): boolean {
  return bind === '127.0.0.1' || bind === '::1' || bind === 'localhost';
}

async function main(): Promise<void> {
  const config = loadConfig();

  if (!isLoopback(config.httpBind)) {
    log.error(
      `HEDERA_HTTP_BIND=${config.httpBind} is not a loopback address. ` +
        `v1 does not support non-loopback HTTP binds (no auth layer). Refusing to start.`,
    );
    process.exit(1);
  }

  log.info('Starting hedera-xeni-mcp-server (http, dev-only)', {
    bind: config.httpBind,
    port: config.httpPort,
    nodeEnv: config.nodeEnv,
  });

  const _toolkit = await buildToolkit(config);

  // TODO: connect the toolkit to StreamableHTTPServerTransport
  // TODO: start HTTP server bound to config.httpBind:config.httpPort
  // TODO: handle SIGTERM / SIGINT for clean shutdown
  throw new Error('http transport: scaffold skeleton; implementation lands in next PR');
}

main().catch((err: unknown) => {
  log.error('http transport failed to start', { error: String(err) });
  process.exit(1);
});
