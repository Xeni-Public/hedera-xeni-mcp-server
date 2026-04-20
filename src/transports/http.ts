// Authored-by: Anand Palanisamy - anand@xeni.com

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

// eslint-disable-next-line @typescript-eslint/require-await -- skeleton; await for transport.start() lands in PR #12 when StreamableHTTPServerTransport wiring replaces the throw below.
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

  // Exercise buildToolkit so its env-parsing + fail-open/closed checks run.
  // Toolkit instance intentionally not retained — PR #12 connects it to
  // StreamableHTTPServerTransport.
  buildToolkit(config);

  // TODO (PR #12): connect the toolkit to StreamableHTTPServerTransport
  // TODO (PR #12): start HTTP server bound to config.httpBind:config.httpPort
  // TODO (PR #12): handle SIGTERM / SIGINT for clean shutdown
  throw new Error('http transport: scaffold skeleton; implementation lands in PR #12');
}

main().catch((err: unknown) => {
  log.error('http transport failed to start', { error: String(err) });
  process.exit(1);
});
