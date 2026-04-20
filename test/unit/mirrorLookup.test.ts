// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * Unit tests for `scripts/lib/mirrorLookup.ts`. Mock `fetch` — no network
 * I/O. Covers the two lookup operations used by the bootstrap scripts:
 *   - findTopicByMemo (M3 idempotency preamble)
 *   - fetchAccountPublicKey (M3 agent-public-key lookup for submit_key)
 *
 * Plus the network-URL + error-path behaviors shared by both.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  fetchAccountMemo,
  fetchAccountPublicKey,
  findTopicByMemo,
  mirrorNodeBaseUrl,
  type FetchFn,
} from '../../scripts/lib/mirrorLookup.js';

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

describe('mirrorLookup / mirrorNodeBaseUrl', () => {
  it('returns the canonical testnet URL', () => {
    expect(mirrorNodeBaseUrl('testnet')).toBe('https://testnet.mirrornode.hedera.com');
  });

  it('returns the canonical mainnet URL', () => {
    expect(mirrorNodeBaseUrl('mainnet')).toBe('https://mainnet-public.mirrornode.hedera.com');
  });
});

describe('mirrorLookup / findTopicByMemo', () => {
  it('returns the topic_id when a single-page result contains the memo', async () => {
    const fetchImpl = mockFetch({
      body: {
        topics: [
          { topic_id: '0.0.9001', memo: 'other_memo' },
          { topic_id: '0.0.9002', memo: 'xeni_audit_v1_dev' },
        ],
        links: { next: null },
      },
    });
    const result = await findTopicByMemo('0.0.1001', 'xeni_audit_v1_dev', 'testnet', {
      fetchImpl,
    });
    expect(result).toBe('0.0.9002');
  });

  it('returns null when no topic matches', async () => {
    const fetchImpl = mockFetch({
      body: { topics: [{ topic_id: '0.0.9001', memo: 'unrelated' }], links: { next: null } },
    });
    const result = await findTopicByMemo('0.0.1001', 'xeni_audit_v1_dev', 'testnet', {
      fetchImpl,
    });
    expect(result).toBeNull();
  });

  it('returns null when the topics array is empty', async () => {
    const fetchImpl = mockFetch({ body: { topics: [], links: { next: null } } });
    expect(
      await findTopicByMemo('0.0.1001', 'xeni_audit_v1_dev', 'testnet', { fetchImpl }),
    ).toBeNull();
  });

  it('paginates through multiple pages until a match is found', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchFn = vi.fn(
      // eslint-disable-next-line @typescript-eslint/require-await -- mock
      async (url: string) => {
        calls.push(url);
        if (url.includes('page=2')) {
          return {
            ok: true,
            status: 200,
            // eslint-disable-next-line @typescript-eslint/require-await -- mock
            json: async () => ({
              topics: [{ topic_id: '0.0.9999', memo: 'xeni_audit_v1_dev' }],
              links: { next: null },
            }),
          } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          // eslint-disable-next-line @typescript-eslint/require-await -- mock
          json: async () => ({
            topics: [{ topic_id: '0.0.9001', memo: 'unrelated' }],
            links: { next: '/api/v1/topics?page=2' },
          }),
        } as unknown as Response;
      },
    );

    const result = await findTopicByMemo('0.0.1001', 'xeni_audit_v1_dev', 'testnet', {
      fetchImpl,
    });
    expect(result).toBe('0.0.9999');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('page=2');
  });

  it('URL-encodes the operator ID in the query', async () => {
    const fetchImpl = mockFetch({ body: { topics: [], links: { next: null } } });
    await findTopicByMemo('0.0/1001', 'xeni_audit_v1_dev', 'testnet', { fetchImpl });
    const url = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(url).toContain('0.0%2F1001');
  });

  it('throws on HTTP non-2xx from Mirror Node', async () => {
    const fetchImpl = mockFetch({ ok: false, status: 503 });
    await expect(
      findTopicByMemo('0.0.1001', 'xeni_audit_v1_dev', 'testnet', { fetchImpl }),
    ).rejects.toThrow(/HTTP 503/);
  });

  it('throws on malformed response (missing topics array)', async () => {
    const fetchImpl = mockFetch({ body: { notTopics: [] } });
    await expect(
      findTopicByMemo('0.0.1001', 'xeni_audit_v1_dev', 'testnet', { fetchImpl }),
    ).rejects.toThrow(/missing "topics" array/);
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
    const result = await fetchAccountPublicKey('0.0.1002', 'testnet', { fetchImpl });
    expect(result.type).toBe('ECDSA_SECP256K1');
    expect(result.hex).toBe('0340e0dd09b1e5e8f1c4f2e7c5d0f3b4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1');
  });

  it('throws when account has no single key (key-list accounts rejected)', async () => {
    const fetchImpl = mockFetch({
      body: { account: '0.0.1002', key: null },
    });
    await expect(fetchAccountPublicKey('0.0.1002', 'testnet', { fetchImpl })).rejects.toThrow(
      /no single-key/,
    );
  });

  it('throws on HTTP non-2xx', async () => {
    const fetchImpl = mockFetch({ ok: false, status: 404 });
    await expect(fetchAccountPublicKey('0.0.9999', 'testnet', { fetchImpl })).rejects.toThrow(
      /HTTP 404/,
    );
  });

  it('throws on timeout (AbortError)', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    const fetchImpl = mockFetch({ throws: abortErr });
    await expect(
      fetchAccountPublicKey('0.0.1002', 'testnet', { fetchImpl, timeoutMs: 10 }),
    ).rejects.toThrow(/timed out after 10ms/);
  });

  it('throws on general network error', async () => {
    const fetchImpl = mockFetch({ throws: new TypeError('fetch failed') });
    await expect(fetchAccountPublicKey('0.0.1002', 'testnet', { fetchImpl })).rejects.toThrow(
      /network error/,
    );
  });

  it('URL-encodes the account ID in the path', async () => {
    const fetchImpl = mockFetch({
      body: { key: { _type: 'ECDSA_SECP256K1', key: 'deadbeef' } },
    });
    await fetchAccountPublicKey('0.0/1002', 'testnet', { fetchImpl });
    const url = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(url).toContain('0.0%2F1002');
  });
});

describe('mirrorLookup / fetchAccountMemo', () => {
  it('returns the memo string on happy path', async () => {
    const fetchImpl = mockFetch({
      body: { account: '0.0.2001', memo: 'xeni_treasury_v1_testnet-uat' },
    });
    const memo = await fetchAccountMemo('0.0.2001', 'testnet', { fetchImpl });
    expect(memo).toBe('xeni_treasury_v1_testnet-uat');
  });

  it('returns null when the account has no memo (empty or missing field)', async () => {
    const fetchImpl = mockFetch({ body: { account: '0.0.2001' } });
    const memo = await fetchAccountMemo('0.0.2001', 'testnet', { fetchImpl });
    expect(memo).toBeNull();
  });

  it('returns empty string when memo is explicitly empty', async () => {
    const fetchImpl = mockFetch({ body: { account: '0.0.2001', memo: '' } });
    const memo = await fetchAccountMemo('0.0.2001', 'testnet', { fetchImpl });
    expect(memo).toBe('');
  });

  it('throws on HTTP 404 (account not found)', async () => {
    const fetchImpl = mockFetch({ ok: false, status: 404 });
    await expect(fetchAccountMemo('0.0.9999', 'testnet', { fetchImpl })).rejects.toThrow(
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
    await expect(fetchAccountMemo('0.0.2001', 'testnet', { fetchImpl })).rejects.toThrow(
      /non-object body/,
    );
  });

  it('URL-encodes the account ID in the path', async () => {
    const fetchImpl = mockFetch({ body: { account: '0.0/2001', memo: 'x' } });
    await fetchAccountMemo('0.0/2001', 'testnet', { fetchImpl });
    const url = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(url).toContain('0.0%2F2001');
  });
});
