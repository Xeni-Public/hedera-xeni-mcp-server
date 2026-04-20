// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * Integration tests for `src/transports/http.ts` — validates the HTTP
 * transport's loopback-bind invariant, its toolkit-wiring path, and the
 * full listen/shutdown lifecycle on a real loopback port.
 *
 * Strategy:
 *   - Unit-level tests for `isLoopback()` (pure function).
 *   - Integration tests set HEDERA_HTTP_PORT=0 so the OS assigns a free
 *     port — avoids port collisions in CI and with other tests.
 *   - Each test tears down via `handle.close()` so the process doesn't leak
 *     listening sockets (vitest detects open handles and fails the run).
 *   - An ECDSA key is generated per test; the MCP doesn't make network
 *     calls here (Client.forName + toolkit construction are synchronous +
 *     in-memory), so no real testnet account is needed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrivateKey } from '@hiero-ledger/sdk';
import { loadConfig } from '../../src/server.js';
import { isLoopback, startHttpServer, type HttpServerHandle } from '../../src/transports/http.js';

function generateAgentEnv(): { id: string; key: string } {
  const pk = PrivateKey.generateECDSA();
  return { id: '0.0.1234567', key: pk.toStringRaw() };
}

describe('http transport / isLoopback', () => {
  it('accepts 127.0.0.1', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
  });

  it('accepts ::1', () => {
    expect(isLoopback('::1')).toBe(true);
  });

  it('accepts localhost', () => {
    expect(isLoopback('localhost')).toBe(true);
  });

  it('rejects 0.0.0.0', () => {
    expect(isLoopback('0.0.0.0')).toBe(false);
  });

  it('rejects a public IP', () => {
    expect(isLoopback('203.0.113.42')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isLoopback('')).toBe(false);
  });
});

describe('http transport / startHttpServer', () => {
  const savedEnv = { ...process.env };
  let handle: HttpServerHandle | undefined;

  beforeEach(() => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('HEDERA_') || k === 'NODE_ENV') delete process.env[k];
    }
    handle = undefined;
  });

  afterEach(async () => {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // best-effort teardown
      }
    }
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('HEDERA_') || k === 'NODE_ENV') delete process.env[k];
    }
    Object.assign(process.env, savedEnv);
  });

  it('refuses a non-loopback bind', async () => {
    const agent = generateAgentEnv();
    process.env['HEDERA_AGENT_ID'] = agent.id;
    process.env['HEDERA_AGENT_KEY'] = agent.key;
    process.env['HEDERA_HTTP_BIND'] = '0.0.0.0';
    process.env['HEDERA_HTTP_PORT'] = '0';

    const config = loadConfig();
    await expect(startHttpServer(config)).rejects.toThrow(/not a loopback/i);
  });

  it('starts on a loopback bind + random port and exposes the bound port', async () => {
    const agent = generateAgentEnv();
    process.env['HEDERA_AGENT_ID'] = agent.id;
    process.env['HEDERA_AGENT_KEY'] = agent.key;
    process.env['HEDERA_HTTP_BIND'] = '127.0.0.1';
    process.env['HEDERA_HTTP_PORT'] = '0'; // OS picks a free port

    const config = loadConfig();
    handle = await startHttpServer(config);

    expect(handle.boundPort).toBeGreaterThan(0);
    expect(handle.server.listening).toBe(true);
  });

  it('responds to a TCP connection on the bound port (proves port is served, not MCP routing)', async () => {
    const agent = generateAgentEnv();
    process.env['HEDERA_AGENT_ID'] = agent.id;
    process.env['HEDERA_AGENT_KEY'] = agent.key;
    process.env['HEDERA_HTTP_BIND'] = '127.0.0.1';
    process.env['HEDERA_HTTP_PORT'] = '0';

    const config = loadConfig();
    handle = await startHttpServer(config);

    // Deliberately scoped claim: this test proves the TCP socket is bound +
    // the Node `http.createServer` handler fires. It does NOT prove MCP
    // protocol routing works, because the default `allowedHosts` allowlist
    // is computed with `config.httpPort=0` (test-only), which never matches
    // a real Host header like `127.0.0.1:54321`. So the 4xx/5xx we see here
    // is most likely the transport's host-rejection path — still a valid
    // HTTP response, which is all this test asserts. MCP routing is covered
    // by the next test using the `{ allowedHosts: null }` override.
    const res = await fetch(`http://127.0.0.1:${handle.boundPort}/mcp`, {
      method: 'GET',
    });
    expect(res.status).toBeGreaterThanOrEqual(100);
    expect(res.status).toBeLessThan(600);
  });

  it('with allowedHosts disabled, bare GET is rejected by the MCP routing layer (not the host allowlist)', async () => {
    const agent = generateAgentEnv();
    process.env['HEDERA_AGENT_ID'] = agent.id;
    process.env['HEDERA_AGENT_KEY'] = agent.key;
    process.env['HEDERA_HTTP_BIND'] = '127.0.0.1';
    process.env['HEDERA_HTTP_PORT'] = '0';

    const config = loadConfig();
    handle = await startHttpServer(config, { allowedHosts: null });

    // With allowedHosts disabled, the Host header can't reject the request.
    // A bare GET still fails (no MCP session), but the failure now proves
    // the transport's MCP routing actually processed the request and chose
    // to reject it for protocol reasons — not an upstream Host filter.
    const res = await fetch(`http://127.0.0.1:${handle.boundPort}/mcp`, {
      method: 'GET',
    });

    // The transport returns a structured JSON-RPC error for missing session;
    // whatever status it picks, it should be a client error (4xx) indicating
    // the request reached the MCP layer.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);

    // Body should be JSON (the transport's error response format), not
    // an upstream "Forbidden" or empty 403 from host-header rejection.
    const ct = res.headers.get('content-type') ?? '';
    expect(ct).toContain('application/json');
  });

  it('close() shuts down cleanly and frees the port', async () => {
    const agent = generateAgentEnv();
    process.env['HEDERA_AGENT_ID'] = agent.id;
    process.env['HEDERA_AGENT_KEY'] = agent.key;
    process.env['HEDERA_HTTP_BIND'] = '127.0.0.1';
    process.env['HEDERA_HTTP_PORT'] = '0';

    const config = loadConfig();
    handle = await startHttpServer(config);
    const port = handle.boundPort;

    await handle.close();
    handle = undefined; // prevent afterEach double-close

    expect(port).toBeGreaterThan(0);
    // A follow-up fetch should fail with a connection error — the server
    // is gone. Using a short timeout via AbortController so a flaky CI
    // doesn't hang this test.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 1000);
    await expect(
      fetch(`http://127.0.0.1:${port}/mcp`, { method: 'GET', signal: ac.signal }),
    ).rejects.toThrow();
    clearTimeout(timer);
  });

  it('refuses to start in production env (loadConfig enforces)', () => {
    const agent = generateAgentEnv();
    process.env['HEDERA_AGENT_ID'] = agent.id;
    process.env['HEDERA_AGENT_KEY'] = agent.key;
    process.env['NODE_ENV'] = 'production';
    process.env['HEDERA_TRANSPORT'] = 'http';

    // loadConfig() calls process.exit(1) on this combo; wrap to assert
    // the intent. vitest turns process.exit into a throw via `expect`.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('process.exit called');
    }) as never);

    try {
      expect(() => loadConfig()).toThrow(/process\.exit called/);
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });
});
