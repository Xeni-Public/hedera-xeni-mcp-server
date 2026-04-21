// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * Unit tests for the `runSmoke` orchestrator in
 * `scripts/smoke-mirror-node.ts` (issue #22).
 *
 * Covers: all-pass summary, mixed pass/fail, failure collection, and
 * stderr log shape. `main()` + CLI guard + real `defaultLogStderr` are
 * v8-ignored (CLI invocation scope) and exercised via the nightly CI
 * workflow-dispatch run after merge.
 */

import { describe, expect, it, vi } from 'vitest';
import { runSmoke } from '../../scripts/smoke-mirror-node.js';
import type { EndpointProbe } from '../../scripts/lib/mirrorSmoke.js';

function mkProbe(partial: Partial<EndpointProbe> = {}): EndpointProbe {
  return {
    label: 'GET /api/v1/test',
    url: 'https://example.test/api/v1/test',
    classification: 'prod-path',
    shape: () => undefined,
    ...partial,
  };
}

function mkResponse(init: { ok: boolean; status?: number; body?: unknown }): Response {
  return {
    ok: init.ok,
    status: init.status ?? (init.ok ? 200 : 500),
    // eslint-disable-next-line @typescript-eslint/require-await -- mock
    json: async () => init.body ?? {},
  } as unknown as Response;
}

// eslint-disable-next-line @typescript-eslint/require-await -- mock
async function noopSleep(): Promise<void> {
  // intentional no-op
}

describe('runSmoke', () => {
  it('returns passed=n, failed=0 when every probe succeeds', async () => {
    // eslint-disable-next-line @typescript-eslint/require-await -- mock
    const fetchImpl = vi.fn(async () =>
      mkResponse({ ok: true, body: { topic_id: '0.0.1', account: '0.0.2' } }),
    );
    const logStderr = vi.fn();
    const probes: EndpointProbe[] = [
      mkProbe({
        label: 'GET /api/v1/topics/0.0.1',
        shape: (b) => {
          if (!(typeof b === 'object' && b !== null && 'topic_id' in b)) throw new Error('shape');
        },
      }),
      mkProbe({
        label: 'GET /api/v1/accounts/0.0.2',
        shape: (b) => {
          if (!(typeof b === 'object' && b !== null && 'account' in b)) throw new Error('shape');
        },
      }),
    ];
    const result = await runSmoke(
      { probes },
      { fetchImpl, sleep: noopSleep, logStderr, attempts: 1 },
    );
    expect(result).toEqual({ passed: 2, failed: 0, failures: [] });
    // one [OK] line per probe + one [SUMMARY] line
    expect(logStderr).toHaveBeenCalledTimes(3);
    expect(logStderr).toHaveBeenCalledWith(expect.stringContaining('[OK]'));
    expect(logStderr).toHaveBeenCalledWith(expect.stringContaining('[SUMMARY]'));
  });

  it('records failure messages with the classification prefix', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(mkResponse({ ok: true, body: { topic_id: '0.0.1' } }))
      .mockResolvedValueOnce(mkResponse({ ok: false, status: 404 }));
    const logStderr = vi.fn();
    const probes: EndpointProbe[] = [
      mkProbe({
        label: 'GET /api/v1/topics/0.0.1',
        classification: 'prod-path',
        shape: (b) => {
          if (!(typeof b === 'object' && b !== null && 'topic_id' in b)) throw new Error('shape');
        },
      }),
      mkProbe({
        label: 'GET /api/v1/topics/0.0.1/messages',
        classification: 'test-infra',
      }),
    ];
    const result = await runSmoke(
      { probes },
      { fetchImpl, sleep: noopSleep, logStderr, attempts: 1 },
    );
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain('SMOKE FAIL [test-infra]:');
    expect(result.failures[0]).toContain('HTTP 404');
  });

  it('returns a failure summary when every probe fails', async () => {
    // eslint-disable-next-line @typescript-eslint/require-await -- mock
    const fetchImpl = vi.fn(async () => mkResponse({ ok: false, status: 503 }));
    const logStderr = vi.fn();
    const probes: EndpointProbe[] = [
      mkProbe({ label: 'GET /api/v1/topics/0.0.1' }),
      mkProbe({ label: 'GET /api/v1/accounts/0.0.2' }),
      mkProbe({ label: 'GET /api/v1/accounts/0.0.3/allowances/crypto' }),
    ];
    const result = await runSmoke(
      { probes },
      { fetchImpl, sleep: noopSleep, logStderr, attempts: 1 },
    );
    expect(result).toMatchObject({ passed: 0, failed: 3 });
    expect(result.failures).toHaveLength(3);
    for (const msg of result.failures) {
      expect(msg).toContain('SMOKE FAIL');
      expect(msg).toContain('HTTP 503');
    }
  });

  it('emits a [SUMMARY] line with counts', async () => {
    // eslint-disable-next-line @typescript-eslint/require-await -- mock
    const fetchImpl = vi.fn(async () => mkResponse({ ok: false, status: 500 }));
    const lines: string[] = [];
    const logStderr = (m: string): void => {
      lines.push(m);
    };
    await runSmoke(
      { probes: [mkProbe(), mkProbe()] },
      { fetchImpl, sleep: noopSleep, logStderr, attempts: 1 },
    );
    const summaryLine = lines.find((l) => l.includes('[SUMMARY]'));
    expect(summaryLine).toBeDefined();
    expect(summaryLine).toContain('0 passed');
    expect(summaryLine).toContain('2 failed');
    expect(summaryLine).toContain('out of 2');
  });

  it('falls back to the default logStderr if none is supplied (smoke test on no-throw)', async () => {
    // We intentionally don't pass logStderr; the default writes to
    // console.error. Capture via vitest's console.error spy to avoid
    // noise in the test output.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      // eslint-disable-next-line @typescript-eslint/require-await -- mock
      const fetchImpl = vi.fn(async () => mkResponse({ ok: true, body: { topic_id: '0.0.1' } }));
      await runSmoke(
        {
          probes: [
            mkProbe({
              shape: (b) => {
                if (!(typeof b === 'object' && b !== null && 'topic_id' in b))
                  throw new Error('shape');
              },
            }),
          ],
        },
        { fetchImpl, sleep: noopSleep, attempts: 1 },
      );
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
