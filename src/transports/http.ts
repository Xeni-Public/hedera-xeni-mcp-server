// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * HTTP (StreamableHTTP) transport — dev debug only.
 *
 * Binds the HederaMCPToolkit to a `StreamableHTTPServerTransport` served
 * by a Node.js `http.createServer`. Intended for local MCP-tool debugging
 * (`npm run start:http`); never deployed to production. See docs/DESIGN.md §8.
 *
 * Hard rules:
 *   - `NODE_ENV=production` refused (loadConfig enforces).
 *   - Non-loopback `HEDERA_HTTP_BIND` refused (v1 has no auth layer).
 *   - `allowedHosts` allowlist enforces Host-header validation as a
 *     defense-in-depth measure behind the loopback bind.
 *
 * The `startHttpServer(config)` export is the testable entry — returns a
 * handle whose `close()` performs graceful shutdown (http server → transport
 * → toolkit). The top-level `main()` is the CLI-only wrapper and runs only
 * when this file is executed directly (not when imported by tests).
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { buildToolkit, loadConfig, type ServerConfig } from '../server.js';
import { log } from '../logger.js';

/**
 * Loopback-bind check. Accepts the three canonical loopback values we honor.
 * Exported so integration tests can assert the invariant directly.
 */
export function isLoopback(bind: string): boolean {
  return bind === '127.0.0.1' || bind === '::1' || bind === 'localhost';
}

/**
 * Handle returned by `startHttpServer` for lifecycle management.
 * `boundPort` is the actually-assigned port (resolves when `config.httpPort=0`
 * lets the OS pick one — useful in tests).
 */
export interface HttpServerHandle {
  server: Server;
  boundPort: number;
  close: () => Promise<void>;
}

/**
 * Build the toolkit + transport, bind an HTTP server on the configured
 * loopback address, and return a handle. Throws synchronously-rejected
 * promise if the bind address is non-loopback.
 */
export async function startHttpServer(config: ServerConfig): Promise<HttpServerHandle> {
  if (!isLoopback(config.httpBind)) {
    throw new Error(
      `HEDERA_HTTP_BIND=${config.httpBind} is not a loopback address. ` +
        `v1 does not support non-loopback HTTP binds (no auth layer). Refusing to start.`,
    );
  }

  const toolkit = buildToolkit(config);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    // `allowedHosts` is marked @deprecated upstream in favor of external
    // middleware, but the built-in allowlist is a useful defense-in-depth
    // line behind the (primary) loopback bind. When `config.httpPort=0` is
    // used for tests, the `:0` entries will never match a real Host header —
    // tests that drive real traffic through the transport disable host
    // validation explicitly via their own transport instance.
    allowedHosts: [
      `${config.httpBind}:${config.httpPort}`,
      `127.0.0.1:${config.httpPort}`,
      `localhost:${config.httpPort}`,
    ],
  });

  // Cast is needed because `StreamableHTTPServerTransport` exposes `onclose`
  // as a getter whose return type is `(() => void) | undefined`, which trips
  // our `exactOptionalPropertyTypes: true` setting (the `Transport` interface
  // declares `onclose?: () => void`, i.e. optional-property-only, not
  // undefined-valued). `StdioServerTransport` declares the field directly so
  // it doesn't hit this quirk. Upstream typing issue; runtime is fine.
  await toolkit.connect(transport as unknown as Transport);

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    transport.handleRequest(req, res).catch((err: unknown) => {
      log.error('http transport handleRequest threw', { error: String(err) });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal_server_error' }));
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.httpPort, config.httpBind, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const boundPort =
    typeof address === 'object' && address !== null ? address.port : config.httpPort;

  log.info('http transport listening', {
    bind: config.httpBind,
    port: boundPort,
    nodeEnv: config.nodeEnv,
    envLabel: config.envLabel,
  });

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      server.close((err?: Error) => (err ? reject(err) : resolve()));
    });
    await transport.close();
    await toolkit.close();
  };

  return { server, boundPort, close };
}

/**
 * CLI entry point. Runs only when this file is executed directly via
 * `node dist/transports/http.js` (or the `start:http` npm script).
 * Tests import `startHttpServer` / `isLoopback` without triggering this,
 * so `main()` + the entry-point check below are excluded from coverage
 * via the `v8 ignore` markers — they are exercised only at dev-shell
 * invocation time, which is out of unit/integration test scope.
 */
/* v8 ignore start */
async function main(): Promise<void> {
  const config = loadConfig();

  log.info('Starting hedera-xeni-mcp-server (http, dev-only)', {
    bind: config.httpBind,
    port: config.httpPort,
    nodeEnv: config.nodeEnv,
    envLabel: config.envLabel,
  });

  const handle = await startHttpServer(config);

  const shutdown = async (signal: string): Promise<void> => {
    log.info(`received ${signal}; shutting down`);
    try {
      await handle.close();
      log.info('http transport closed');
    } catch (err) {
      log.error('error during http transport close', { error: String(err) });
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

// ESM entry-point check: `import.meta.url` equals `pathToFileURL(process.argv[1]).href`
// only when node was invoked directly on this file. When vitest imports the
// module for tests, `process.argv[1]` is the vitest binary, so this branch is
// skipped — keeping the module safely importable.
const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  main().catch((err: unknown) => {
    log.error('http transport failed to start', { error: String(err) });
    process.exit(1);
  });
}
/* v8 ignore stop */
