// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * Unit tests for `scripts/lib/mirrorLookup.ts`. Mock `fetch` — no network
 * I/O. Covers the three lookup operations used by the bootstrap scripts:
 *   - fetchTopicMemo (M3 idempotency verification — issue #18 replacement
 *     for the broken findTopicByMemo)
 *   - fetchAccountMemo (M4 idempotency verification)
 *   - fetchAccountPublicKey (M3 agent-public-key lookup for submit_key)
 *
 * Plus error-path behaviors shared by all three.
 *
 * Mirror Node URL is passed explicitly as an argument (no hardcoded
 * default in the module anymore — see docs/DESIGN.md §3). Tests use a
 * canonical testnet URL constant for readability.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  fetchAccountMemo,
  fetchAccountPublicKey,
  fetchTopicMemo,
  type FetchFn,
} from '../../scripts/lib/mirrorLookup.js';

const TESTNET_MIRROR = 'https://testnet.mirrornode.hedera.com';

function mockFetch(response: {
  ok?: boolean;
  status?: number;
  body?: unknown;
  throws?: Error;
}): FetchFn {
  // eslint-disable-next-line @typescript-eslint/require-await -- mock
  return vi.fn(async () => {
    if (response.throws) throw response.throws;
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      // eslint-disable-next-line @typescript-eslint/require-await -- mock
      json: async () => response.body,
    } as unknown as Response;
  });
}

describe('mirrorLookup / fetchTopicMemo', () => {
  it('returns the memo string on happy path', async () => {
    const fetchImpl = mockFetch({
      body: { topic_id: '0.0.8719397', memo: 'xeni_audit_v1_testnet-ci' },
    });
    const memo = await fetchTopicMemo('0.0.8719397', TESTNET_MIRROR, { fetchImpl });
    expect(memo).toBe('xeni_audit_v1_testnet-ci');
  });

  it('returns null when the topic has no memo (empty or missing field)', async () => {
    const fetchImpl = mockFetch({ body: { topic_id: '0.0.8719397' } });
    const memo = await fetchTopicMemo('0.0.8719397', TESTNET_MIRROR, { fetchImpl });
    expect(memo).toBeNull();
  });

  it('returns empty string when memo is explicitly empty', async () => {
    const fetchImpl = mockFetch({ body: { topic_id: '0.0.8719397', memo: '' } });
    const memo = await fetchTopicMemo('0.0.8719397', TESTNET_MIRROR, { fetchImpl });
    expect(memo).toBe('');
  });

  it('throws on HTTP 404 (topic not found)', async () => {
    const fetchImpl = mockFetch({ ok: false, status: 404 });
    await expect(fetchTopicMemo('0.0.9999', TESTNET_MIRROR, { fetchImpl })).rejects.toThrow(
      /HTTP 404/,
    );
  });

  it('throws on general network error (no Mirror Node reachable)', async () => {
    const fetchImpl = mockFetch({ throws: new TypeError('fetch failed') });
    await expect(fetchTopicMemo('0.0.8719397', TESTNET_MIRROR, { fetchImpl })).rejects.toThrow(
      /network error/,
    );
  });

  it('throws on timeout (AbortError)', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    const fetchImpl = mockFetch({ throws: abortErr });
    await expect(
      fetchTopicMemo('0.0.8719397', TESTNET_MIRROR, { fetchImpl, timeoutMs: 10 }),
    ).rejects.toThrow(/timed out after 10ms/);
  });

  it('throws on non-object response (defensive)', async () => {
    const fetchImpl: FetchFn = vi.fn(
      // eslint-disable-next-line @typescript-eslint/require-await -- mock
      async () =>
        ({
          ok: true,
          status: 200,
          // eslint-disable-next-line @typescript-eslint/require-await -- mock
          json: async () => 'string-not-object',
        }) as unknown as Response,
    );
    await expect(fetchTopicMemo('0.0.8719397', TESTNET_MIRROR, { fetchImpl })).rejects.toThrow(
      /non-object body/,
    );
  });

  it('URL-encodes the topic ID in the path', async () => {
    const fetchImpl = mockFetch({ body: { topic_id: '0.0/8719397', memo: 'x' } });
    await fetchTopicMemo('0.0/8719397', TESTNET_MIRROR, { fetchImpl });
    const url = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(url).toContain('0.0%2F8719397');
  });

  it('hits the correct Mirror Node endpoint (regression-guard for issue #18)', async () => {
    // The bug in PR #15 was that findTopicByMemo hit a non-existent endpoint
    // (/api/v1/topics?account.id=...). Lock the correct endpoint shape in so
    // a future refactor can't silently regress back to a list endpoint.
    const fetchImpl = mockFetch({ body: { topic_id: '0.0.8719397', memo: 'm' } });
    await fetchTopicMemo('0.0.8719397', TESTNET_MIRROR, { fetchImpl });
    const url = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(url).toBe('https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.8719397');
  });

  it('uses the supplied mirrorNodeUrl verbatim (no internal URL construction)', async () => {
    // Proves the URL comes from the caller, not a hardcoded default.
    const fetchImpl = mockFetch({ body: { topic_id: '0.0.1', memo: 'm' } });
    await fetchTopicMemo('0.0.1', 'https://custom.mirror.example.com', { fetchImpl });
    const url = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(url).toBe('https://custom.mirror.example.com/api/v1/topics/0.0.1');
  });
});

describe('mirrorLookup / fetchAccountPublicKey', () => {
  it('returns { type, hex } on happy path', async () => {
    const fetchImpl = mockFetch({
      body: {
        account: '0.0.1002',
        key: {
          _type: 'ECDSA_SECP256K1',
          key: '0340e0dd09b1e5e8f1c4f2e7c5d0f3b4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1',
        },
      },
    });
    const result = await fetchAccountPublicKey('0.0.1002', TESTNET_MIRROR, { fetchImpl });
    expect(result.type).toBe('ECDSA_SECP256K1');
    expect(result.hex).toBe('0340e0dd09b1e5e8f1c4f2e7c5d0f3b4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1');
  });

  it('throws when account has no single key (key-list accounts rejected)', async () => {
    const fetchImpl = mockFetch({
      body: { account: '0.0.1002', key: null },
    });
    await expect(fetchAccountPublicKey('0.0.1002', TESTNET_MIRROR, { fetchImpl })).rejects.toThrow(
      /no single-key/,
    );
  });

  it('throws on HTTP non-2xx', async () => {
    const fetchImpl = mockFetch({ ok: false, status: 404 });
    await expect(fetchAccountPublicKey('0.0.9999', TESTNET_MIRROR, { fetchImpl })).rejects.toThrow(
      /HTTP 404/,
    );
  });

  it('throws on timeout (AbortError)', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    const fetchImpl = mockFetch({ throws: abortErr });
    await expect(
      fetchAccountPublicKey('0.0.1002', TESTNET_MIRROR, { fetchImpl, timeoutMs: 10 }),
    ).rejects.toThrow(/timed out after 10ms/);
  });

  it('throws on general network error', async () => {
    const fetchImpl = mockFetch({ throws: new TypeError('fetch failed') });
    await expect(fetchAccountPublicKey('0.0.1002', TESTNET_MIRROR, { fetchImpl })).rejects.toThrow(
      /network error/,
    );
  });

  it('URL-encodes the account ID in the path', async () => {
    const fetchImpl = mockFetch({
      body: { key: { _type: 'ECDSA_SECP256K1', key: 'deadbeef' } },
    });
    await fetchAccountPublicKey('0.0/1002', TESTNET_MIRROR, { fetchImpl });
    const url = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(url).toContain('0.0%2F1002');
  });
});

describe('mirrorLookup / fetchAccountMemo', () => {
  it('returns the memo string on happy path', async () => {
    const fetchImpl = mockFetch({
      body: { account: '0.0.2001', memo: 'xeni_treasury_v1_testnet-uat' },
    });
    const memo = await fetchAccountMemo('0.0.2001', TESTNET_MIRROR, { fetchImpl });
    expect(memo).toBe('xeni_treasury_v1_testnet-uat');
  });

  it('returns null when the account has no memo (empty or missing field)', async () => {
    const fetchImpl = mockFetch({ body: { account: '0.0.2001' } });
    const memo = await fetchAccountMemo('0.0.2001', TESTNET_MIRROR, { fetchImpl });
    expect(memo).toBeNull();
  });

  it('returns empty string when memo is explicitly empty', async () => {
    const fetchImpl = mockFetch({ body: { account: '0.0.2001', memo: '' } });
    const memo = await fetchAccountMemo('0.0.2001', TESTNET_MIRROR, { fetchImpl });
    expect(memo).toBe('');
  });

  it('throws on HTTP 404 (account not found)', async () => {
    const fetchImpl = mockFetch({ ok: false, status: 404 });
    await expect(fetchAccountMemo('0.0.9999', TESTNET_MIRROR, { fetchImpl })).rejects.toThrow(
      /HTTP 404/,
    );
  });

  it('throws on non-object response (defensive)', async () => {
    const fetchImpl: FetchFn = vi.fn(
      // eslint-disable-next-line @typescript-eslint/require-await -- mock
      async () =>
        ({
          ok: true,
          status: 200,
          // eslint-disable-next-line @typescript-eslint/require-await -- mock
          json: async () => 'string-not-object',
        }) as unknown as Response,
    );
    await expect(fetchAccountMemo('0.0.2001', TESTNET_MIRROR, { fetchImpl })).rejects.toThrow(
      /non-object body/,
    );
  });

  it('URL-encodes the account ID in the path', async () => {
    const fetchImpl = mockFetch({ body: { account: '0.0/2001', memo: 'x' } });
    await fetchAccountMemo('0.0/2001', TESTNET_MIRROR, { fetchImpl });
    const url = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(url).toContain('0.0%2F2001');
  });
});
