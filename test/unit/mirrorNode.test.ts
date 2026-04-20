// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * Unit tests for `src/plugins/xeniRead/mirrorNode.ts` — the Mirror Node
 * REST helper. Pure function + fetch-wrapper tests with a mock `FetchFn`,
 * so no network I/O. Validates URL construction, shape parsing, error
 * paths (HTTP non-2xx / network / timeout / bad JSON), and the
 * `sumRemainingTinybar` math.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  fetchCryptoAllowances,
  mirrorNodeBaseUrl,
  sumRemainingTinybar,
  type MirrorCryptoAllowanceResponse,
  type FetchFn,
} from '../../src/plugins/xeniRead/mirrorNode.js';

describe('mirrorNode / mirrorNodeBaseUrl', () => {
  it('returns the canonical testnet URL', () => {
    expect(mirrorNodeBaseUrl('testnet')).toBe('https://testnet.mirrornode.hedera.com');
  });

  it('returns the canonical mainnet URL', () => {
    expect(mirrorNodeBaseUrl('mainnet')).toBe('https://mainnet-public.mirrornode.hedera.com');
  });

  it('throws on unknown network', () => {
    expect(() => mirrorNodeBaseUrl('previewnet')).toThrow(/Unknown Hedera network/);
  });

  it('throws on empty string', () => {
    expect(() => mirrorNodeBaseUrl('')).toThrow(/Unknown Hedera network/);
  });
});

describe('mirrorNode / sumRemainingTinybar', () => {
  it('returns 0n for an empty allowances array', () => {
    const res: MirrorCryptoAllowanceResponse = { allowances: [], links: { next: null } };
    expect(sumRemainingTinybar(res)).toBe(0n);
  });

  it('sums a single entry', () => {
    const res: MirrorCryptoAllowanceResponse = {
      allowances: [
        {
          amount: 123_456,
          amount_granted: 1_000_000,
          owner: '0.0.1001',
          spender: '0.0.1002',
          timestamp: { from: '1', to: null },
        },
      ],
      links: { next: null },
    };
    expect(sumRemainingTinybar(res)).toBe(123_456n);
  });

  it('sums multiple entries (defensive against duplicate rows)', () => {
    const res: MirrorCryptoAllowanceResponse = {
      allowances: [
        {
          amount: 100,
          amount_granted: 1000,
          owner: '0.0.1001',
          spender: '0.0.1002',
          timestamp: { from: '1', to: null },
        },
        {
          amount: 50,
          amount_granted: 500,
          owner: '0.0.1001',
          spender: '0.0.1002',
          timestamp: { from: '2', to: null },
        },
      ],
      links: { next: null },
    };
    expect(sumRemainingTinybar(res)).toBe(150n);
  });

  it('handles large tinybar values without rounding (BigInt safety)', () => {
    // 9e15 tinybar = 90,000,000 HBAR — beyond what float32 stays exact on
    // but well within IEEE-754 double-precision. BigInt keeps it exact
    // either way.
    const res: MirrorCryptoAllowanceResponse = {
      allowances: [
        {
          amount: 9_000_000_000_000_000,
          amount_granted: 9_000_000_000_000_000,
          owner: '0.0.1001',
          spender: '0.0.1002',
          timestamp: { from: '1', to: null },
        },
      ],
      links: { next: null },
    };
    expect(sumRemainingTinybar(res)).toBe(9_000_000_000_000_000n);
  });

  it('throws (fails loud) on fractional tinybar amounts — tinybar is integer on-chain', () => {
    // Hypothetical bad upstream: 123.7 is not a valid tinybar. We want to
    // know about shape surprises, not silently truncate and under-count.
    // Matches the rest of mirrorNode.ts's fail-loud stance.
    const res: MirrorCryptoAllowanceResponse = {
      allowances: [
        {
          amount: 123.7,
          amount_granted: 1000,
          owner: '0.0.1001',
          spender: '0.0.1002',
          timestamp: { from: '1', to: null },
        },
      ],
      links: { next: null },
    };
    expect(() => sumRemainingTinybar(res)).toThrow(/non-integer tinybar amount/);
  });
});

describe('mirrorNode / fetchCryptoAllowances', () => {
  function mockFetch(
    response:
      | { ok: true; status?: number; body: unknown }
      | { ok: false; status: number; body?: unknown }
      | { throws: Error | string },
  ): FetchFn {
    // Test helper; intentionally trivial async bodies (no actual await).
    // eslint-disable-next-line @typescript-eslint/require-await -- mock
    return vi.fn(async () => {
      if ('throws' in response) {
        const err = response.throws;
        throw err instanceof Error ? err : new Error(err);
      }
      return {
        ok: response.ok,
        status: response.status ?? (response.ok ? 200 : 500),
        // eslint-disable-next-line @typescript-eslint/require-await -- mock
        json: async () => response.body,
      } as unknown as Response;
    });
  }

  it('constructs the correct URL and returns parsed JSON on 200', async () => {
    const body: MirrorCryptoAllowanceResponse = {
      allowances: [
        {
          amount: 500_000,
          amount_granted: 1_000_000,
          owner: '0.0.1001',
          spender: '0.0.1002',
          timestamp: { from: '1', to: null },
        },
      ],
      links: { next: null },
    };
    const fetchImpl = mockFetch({ ok: true, body });
    const res = await fetchCryptoAllowances('testnet', '0.0.1001', '0.0.1002', { fetchImpl });

    expect(res).toEqual(body);
    // Assert fetch was called with the correct URL. The second arg (init)
    // carries an `AbortSignal`; we validate its presence in a separate,
    // type-safe way below rather than `expect.objectContaining` which
    // typed-any's through the matcher.
    const call = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call?.[0]).toBe(
      'https://testnet.mirrornode.hedera.com/api/v1/accounts/0.0.1001/allowances/crypto?spender.id=0.0.1002',
    );
    const init = call?.[1] as { signal?: AbortSignal } | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('URL-encodes owner and spender IDs (defensive — account IDs are numeric but...)', async () => {
    const body = { allowances: [], links: { next: null } };
    const fetchImpl = mockFetch({ ok: true, body });
    await fetchCryptoAllowances('testnet', '0.0/1001', '0.0?1002', { fetchImpl });
    const url = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(url).toContain('0.0%2F1001');
    expect(url).toContain('0.0%3F1002');
  });

  it('honors a custom baseUrl override', async () => {
    const body = { allowances: [], links: { next: null } };
    const fetchImpl = mockFetch({ ok: true, body });
    await fetchCryptoAllowances('testnet', '0.0.1001', '0.0.1002', {
      fetchImpl,
      baseUrl: 'https://custom.mirror.example.com',
    });
    const url = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(url).toContain('https://custom.mirror.example.com/');
  });

  it('throws with HTTP status on non-2xx', async () => {
    const fetchImpl = mockFetch({ ok: false, status: 503 });
    await expect(
      fetchCryptoAllowances('testnet', '0.0.1001', '0.0.1002', { fetchImpl }),
    ).rejects.toThrow(/HTTP 503/);
  });

  it('throws with clear message on network error', async () => {
    const fetchImpl = mockFetch({ throws: new TypeError('fetch failed') });
    await expect(
      fetchCryptoAllowances('testnet', '0.0.1001', '0.0.1002', { fetchImpl }),
    ).rejects.toThrow(/Mirror Node network error/);
  });

  it('throws with timeout message on AbortError', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    const fetchImpl = mockFetch({ throws: abortErr });
    await expect(
      fetchCryptoAllowances('testnet', '0.0.1001', '0.0.1002', { fetchImpl, timeoutMs: 10 }),
    ).rejects.toThrow(/timed out after 10ms/);
  });

  it('throws with clear message on invalid JSON', async () => {
    const fetchImpl: FetchFn = vi.fn(
      // eslint-disable-next-line @typescript-eslint/require-await -- mock
      async () =>
        ({
          ok: true,
          status: 200,
          // eslint-disable-next-line @typescript-eslint/require-await -- mock throws synchronously
          json: async () => {
            throw new SyntaxError('Unexpected token');
          },
        }) as unknown as Response,
    );
    await expect(
      fetchCryptoAllowances('testnet', '0.0.1001', '0.0.1002', { fetchImpl }),
    ).rejects.toThrow(/invalid JSON/);
  });

  it('throws with clear message when response is missing allowances array', async () => {
    const fetchImpl = mockFetch({ ok: true, body: { notAllowances: [] } });
    await expect(
      fetchCryptoAllowances('testnet', '0.0.1001', '0.0.1002', { fetchImpl }),
    ).rejects.toThrow(/missing "allowances" array/);
  });

  it('throws when response is null', async () => {
    const fetchImpl = mockFetch({ ok: true, body: null });
    await expect(
      fetchCryptoAllowances('testnet', '0.0.1001', '0.0.1002', { fetchImpl }),
    ).rejects.toThrow(/missing "allowances" array/);
  });

  it('actually times out when fetch is slow (real AbortController behavior)', async () => {
    const slowFetch: FetchFn = vi.fn(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
          // never resolves on its own
        }),
    );
    await expect(
      fetchCryptoAllowances('testnet', '0.0.1001', '0.0.1002', {
        fetchImpl: slowFetch,
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/timed out after 50ms/);
  });
});
