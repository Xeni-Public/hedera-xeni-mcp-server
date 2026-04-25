// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * Unit tests for `scripts/lib/mirrorSmoke.ts` — the pure-logic layer
 * behind the Mirror Node pre-flight smoke-check (issue #22).
 *
 * Covers: probe retry behavior (happy, non-2xx, shape mismatch, network
 * error, all-attempts-fail, succeed-on-2nd-attempt), shape assertions
 * on each of the four endpoints, and `buildProbes()` URL/classification
 * correctness. IO is injected; no real fetches.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  assertAccountShape,
  assertAllowancesShape,
  assertMessagesShape,
  assertTopicShape,
  buildProbes,
  probeEndpoint,
  type EndpointProbe,
} from '../../scripts/lib/mirrorSmoke.js';

function mkProbe(partial: Partial<EndpointProbe> = {}): EndpointProbe {
  return {
    label: 'GET /api/v1/test',
    url: 'https://example.test/api/v1/test',
    classification: 'prod-path',
    shape: () => undefined,
    ...partial,
  };
}

/**
 * Build a Response-shaped stub. Minimal on purpose — we control `ok`,
 * `status`, and what `json()` resolves to.
 */
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

describe('probeEndpoint', () => {
  it('returns ok on first attempt when fetch + shape both succeed', async () => {
    // eslint-disable-next-line @typescript-eslint/require-await -- mock
    const fetchImpl = vi.fn(async () => mkResponse({ ok: true, body: { topic_id: '0.0.1' } }));
    const sleep = vi.fn(noopSleep);
    const result = await probeEndpoint(
      mkProbe({
        shape: (b) => assertTopicShape(b),
      }),
      { fetchImpl, sleep, attempts: 3, delayMs: 5, timeoutMs: 50 },
    );
    expect(result).toEqual({ ok: true, attempts: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries then succeeds on the second attempt', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(mkResponse({ ok: false, status: 503 }))
      .mockResolvedValueOnce(mkResponse({ ok: true, body: { topic_id: '0.0.1' } }));
    const sleep = vi.fn(noopSleep);
    const result = await probeEndpoint(mkProbe({ shape: (b) => assertTopicShape(b) }), {
      fetchImpl,
      sleep,
      attempts: 3,
      delayMs: 5,
      timeoutMs: 50,
    });
    expect(result).toEqual({ ok: true, attempts: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('fails with SMOKE FAIL [prod-path] prefix after exhausting retries on 404', async () => {
    // eslint-disable-next-line @typescript-eslint/require-await -- mock
    const fetchImpl = vi.fn(async () => mkResponse({ ok: false, status: 404 }));
    const sleep = vi.fn(noopSleep);
    const result = await probeEndpoint(
      mkProbe({ label: 'GET /api/v1/topics/0.0.1', classification: 'prod-path' }),
      { fetchImpl, sleep, attempts: 3, delayMs: 5, timeoutMs: 50 },
    );
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(3);
    expect(result.errorMessage).toBe(
      'SMOKE FAIL [prod-path]: GET /api/v1/topics/0.0.1 — HTTP 404 after 3 attempts',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2); // sleep fires BETWEEN attempts, not after the last
  });

  it('fails with SMOKE FAIL [test-infra] prefix for test-infra probes', async () => {
    // eslint-disable-next-line @typescript-eslint/require-await -- mock
    const fetchImpl = vi.fn(async () => mkResponse({ ok: false, status: 500 }));
    const result = await probeEndpoint(
      mkProbe({
        label: 'GET /api/v1/topics/0.0.1/messages',
        classification: 'test-infra',
      }),
      { fetchImpl, sleep: noopSleep, attempts: 3, delayMs: 5, timeoutMs: 50 },
    );
    expect(result.errorMessage).toContain('SMOKE FAIL [test-infra]:');
    expect(result.errorMessage).toContain('HTTP 500');
  });

  it('fails on shape mismatch with the assertion reason in the message', async () => {
    const fetchImpl = vi.fn(
      // eslint-disable-next-line @typescript-eslint/require-await -- mock
      async () => mkResponse({ ok: true, body: { not_what_we_expect: true } }),
    );
    const result = await probeEndpoint(mkProbe({ shape: (b) => assertTopicShape(b) }), {
      fetchImpl,
      sleep: noopSleep,
      attempts: 3,
      delayMs: 5,
      timeoutMs: 50,
    });
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toContain("shape assertion: missing 'topic_id'");
  });

  it('surfaces the underlying thrown error message on network failure', async () => {
    // eslint-disable-next-line @typescript-eslint/require-await -- mock
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const result = await probeEndpoint(mkProbe(), {
      fetchImpl,
      sleep: noopSleep,
      attempts: 2,
      delayMs: 5,
      timeoutMs: 50,
    });
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.errorMessage).toContain('ECONNREFUSED');
  });

  it('coerces non-Error thrown values to string in the failure message', async () => {
    // Reject with a non-Error value (plain object). Exercises the
    // `String(err)` branch inside probeEndpoint's catch.
    const nonErrorRejection: unknown = { toString: () => 'raw-string-rejection' };
    const fetchImpl = vi.fn((): Promise<Response> => Promise.reject(nonErrorRejection as Error));
    const result = await probeEndpoint(mkProbe(), {
      fetchImpl,
      sleep: noopSleep,
      attempts: 1,
      delayMs: 0,
      timeoutMs: 50,
    });
    expect(result.errorMessage).toContain('raw-string-rejection');
  });

  it('uses defaults for attempts when not supplied', async () => {
    // We can't easily verify delay/timeout defaults without waiting 5s,
    // but we can verify attempts (3) by counting fetch calls on an
    // all-fail sequence. Override sleep to no-op.
    // eslint-disable-next-line @typescript-eslint/require-await -- mock
    const fetchImpl = vi.fn(async () => mkResponse({ ok: false, status: 502 }));
    const result = await probeEndpoint(mkProbe(), { fetchImpl, sleep: noopSleep });
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(3);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe('shape assertions', () => {
  it('assertTopicShape passes on a valid topic payload', () => {
    expect(() => assertTopicShape({ topic_id: '0.0.1', memo: 'x' })).not.toThrow();
  });

  it('assertTopicShape throws on missing topic_id', () => {
    expect(() => assertTopicShape({ memo: 'x' })).toThrow(/missing 'topic_id'/);
  });

  it('assertTopicShape throws on non-object bodies', () => {
    expect(() => assertTopicShape(null)).toThrow();
    expect(() => assertTopicShape('nope')).toThrow();
    expect(() => assertTopicShape(42)).toThrow();
  });

  it('assertAccountShape passes on a valid account payload', () => {
    expect(() => assertAccountShape({ account: '0.0.1', memo: 'x' })).not.toThrow();
  });

  it('assertAccountShape throws on missing account', () => {
    expect(() => assertAccountShape({ memo: 'x' })).toThrow(/missing 'account'/);
  });

  it('assertAllowancesShape passes on a valid allowances payload', () => {
    expect(() => assertAllowancesShape({ allowances: [] })).not.toThrow();
    expect(() => assertAllowancesShape({ allowances: [{ amount: 1 }] })).not.toThrow();
  });

  it('assertAllowancesShape throws when allowances is missing or not an array', () => {
    expect(() => assertAllowancesShape({})).toThrow(/missing 'allowances' array/);
    expect(() => assertAllowancesShape({ allowances: 'not-an-array' })).toThrow(
      /missing 'allowances' array/,
    );
  });

  it('assertMessagesShape passes on a valid messages payload', () => {
    expect(() => assertMessagesShape({ messages: [] })).not.toThrow();
  });

  it('assertMessagesShape throws when messages is missing or not an array', () => {
    expect(() => assertMessagesShape({})).toThrow(/missing 'messages' array/);
    expect(() => assertMessagesShape({ messages: { not: 'array' } })).toThrow(
      /missing 'messages' array/,
    );
  });
});

describe('buildProbes', () => {
  const inputs = {
    mirrorNodeUrl: 'https://testnet.mirrornode.hedera.com',
    topicId: '0.0.8719397',
    agentAccountId: '0.0.8666031',
    treasuryAccountId: '0.0.8719505',
  };

  it('returns four probes in the documented order (3 prod-path then 1 test-infra)', () => {
    const probes = buildProbes(inputs);
    expect(probes).toHaveLength(4);
    expect(probes.map((p) => p.classification)).toEqual([
      'prod-path',
      'prod-path',
      'prod-path',
      'test-infra',
    ]);
  });

  it('builds the topic URL against the supplied Mirror Node host', () => {
    const probes = buildProbes(inputs);
    expect(probes[0]?.url).toBe('https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.8719397');
  });

  it('builds the account URL with the agent ID', () => {
    const probes = buildProbes(inputs);
    expect(probes[1]?.url).toBe(
      'https://testnet.mirrornode.hedera.com/api/v1/accounts/0.0.8666031',
    );
  });

  it('builds the allowances URL with owner=treasury + spender.id=agent', () => {
    const probes = buildProbes(inputs);
    expect(probes[2]?.url).toBe(
      'https://testnet.mirrornode.hedera.com/api/v1/accounts/0.0.8719505/allowances/crypto?spender.id=0.0.8666031',
    );
  });

  it('builds the messages URL with order=desc and limit=50', () => {
    const probes = buildProbes(inputs);
    expect(probes[3]?.url).toBe(
      'https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.8719397/messages?order=desc&limit=50',
    );
  });

  it('uses the supplied mirrorNodeUrl verbatim (proves no hardcoded default)', () => {
    const probes = buildProbes({
      ...inputs,
      mirrorNodeUrl: 'https://mainnet-public.mirrornode.hedera.com',
    });
    expect(probes[0]?.url.startsWith('https://mainnet-public.mirrornode.hedera.com/')).toBe(true);
  });

  it('assigns the correct shape assertion per endpoint', () => {
    const probes = buildProbes(inputs);
    expect(() => probes[0]!.shape({ topic_id: '0.0.1' })).not.toThrow();
    expect(() => probes[1]!.shape({ account: '0.0.1' })).not.toThrow();
    expect(() => probes[2]!.shape({ allowances: [] })).not.toThrow();
    expect(() => probes[3]!.shape({ messages: [] })).not.toThrow();
    // And the reverse — wrong shape fails
    expect(() => probes[0]!.shape({ account: '0.0.1' })).toThrow(/topic_id/);
    expect(() => probes[1]!.shape({ topic_id: '0.0.1' })).toThrow(/account/);
  });
});
