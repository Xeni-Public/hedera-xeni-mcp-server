// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * Mirror Node lookups used by bootstrap scripts.
 *
 * Two operations:
 *   - `findTopicByMemo(operatorId, memo, network)` — idempotency preamble
 *     for M3. If a topic with this memo already exists under the operator,
 *     we re-use it rather than minting a duplicate.
 *   - `fetchAccountPublicKey(accountId, network)` — M3 needs the agent's
 *     public key to set as the topic's `submit_key`. Rather than requiring
 *     the bootstrap env to carry the agent's private key (distinct cold-key
 *     concern), we look it up from Mirror Node — public by definition.
 *
 * Shares the same `fetch` wrapper shape as
 * `src/plugins/xeniRead/mirrorNode.ts` for consistency: 5s default timeout
 * via AbortController, grep-distinct error messages per failure layer.
 * Bootstrap scripts are short-lived one-shot runs so there's no
 * caching/retry here — fail loud, ops retries the command.
 */

export type HederaNetwork = 'testnet' | 'mainnet';

const MIRROR_NODE_URLS: Record<HederaNetwork, string> = {
  testnet: 'https://testnet.mirrornode.hedera.com',
  mainnet: 'https://mainnet-public.mirrornode.hedera.com',
};

export function mirrorNodeBaseUrl(network: HederaNetwork): string {
  return MIRROR_NODE_URLS[network];
}

/** Dependency-injected `fetch`. Tests pass a mock; prod uses global. */
export type FetchFn = (input: string, init?: { signal?: AbortSignal }) => Promise<Response>;

interface LookupOptions {
  timeoutMs?: number;
  fetchImpl?: FetchFn;
  /** Optional base URL override (tests); defaults to network-derived URL. */
  baseUrl?: string;
}

/**
 * Shared fetch-with-timeout helper. Throws with grep-distinct messages so
 * ops reading the error log knows which layer broke.
 */
async function fetchJson(url: string, options: LookupOptions): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetchImpl(url, { signal: ac.signal });
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    throw new Error(
      isAbort
        ? `Mirror Node request timed out after ${timeoutMs}ms: ${url}`
        : `Mirror Node network error: ${String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`Mirror Node returned HTTP ${res.status} for ${url} (expected 2xx).`);
  }

  try {
    return await res.json();
  } catch (err) {
    throw new Error(`Mirror Node returned invalid JSON: ${String(err)}`);
  }
}

/**
 * Mirror Node /api/v1/topics response — only the fields we use.
 * See https://docs.hedera.com/hedera/mirror-node-api/rest-api
 */
interface MirrorTopicListResponse {
  topics?: Array<{
    topic_id: string;
    memo?: string;
    admin_key?: { _type: string; key: string } | null;
  }>;
}

/**
 * Find a topic by exact memo match under the given account (operator) as
 * the tx payer. Returns the first match's topic ID, or `null` if none.
 *
 * Mirror Node's `/api/v1/topics` endpoint accepts an `account.id` filter
 * (limited by the payer of the creating tx) plus a memo filter via
 * post-filter. We page through until we either find the memo match or
 * exhaust results.
 *
 * Kept defensive: if the response shape is unexpected, throw loudly with
 * a snippet — consistent with the rest of our Mirror Node wrappers.
 */
export async function findTopicByMemo(
  operatorId: string,
  memo: string,
  network: HederaNetwork,
  options: LookupOptions = {},
): Promise<string | null> {
  const baseUrl = options.baseUrl ?? mirrorNodeBaseUrl(network);
  let url: string | null =
    `${baseUrl}/api/v1/topics?account.id=${encodeURIComponent(operatorId)}&limit=100&order=desc`;

  while (url) {
    const body = (await fetchJson(url, options)) as MirrorTopicListResponse;
    if (!body || typeof body !== 'object' || !Array.isArray(body.topics)) {
      throw new Error(
        `Mirror Node /api/v1/topics response missing "topics" array: ${JSON.stringify(body).slice(0, 200)}`,
      );
    }
    for (const t of body.topics) {
      if (t.memo === memo) return t.topic_id;
    }
    // Pagination: Mirror Node returns `links.next` with a relative path.
    const links = (body as unknown as { links?: { next?: string | null } }).links;
    url = links?.next ? `${baseUrl}${links.next}` : null;
  }

  return null;
}

/**
 * Mirror Node /api/v1/accounts/{id} response — only the fields we use.
 * `key._type` names the algorithm (e.g. "ECDSA_SECP256K1", "ED25519");
 * `key.key` is the hex-encoded public key suitable for Hiero SDK parsing.
 */
interface MirrorAccountInfo {
  account?: string;
  key?: { _type: string; key: string } | null;
}

/**
 * Fetch an account's public key from Mirror Node. Returns the pair
 * `{ type, hex }` where `type` identifies the algorithm for SDK parsing
 * (`PublicKey.fromStringECDSA` vs `.fromStringED25519`).
 *
 * Throws on missing account, missing key field (e.g. an account keyed by
 * a key list), or other shape surprises.
 */
export async function fetchAccountPublicKey(
  accountId: string,
  network: HederaNetwork,
  options: LookupOptions = {},
): Promise<{ type: string; hex: string }> {
  const baseUrl = options.baseUrl ?? mirrorNodeBaseUrl(network);
  const url = `${baseUrl}/api/v1/accounts/${encodeURIComponent(accountId)}`;
  const body = (await fetchJson(url, options)) as MirrorAccountInfo;

  if (!body || typeof body !== 'object') {
    throw new Error(`Mirror Node /accounts/${accountId} returned non-object body.`);
  }
  if (!body.key || typeof body.key !== 'object' || !body.key.key || !body.key._type) {
    throw new Error(
      `Mirror Node /accounts/${accountId} has no single-key — got: ${JSON.stringify(body.key).slice(0, 200)}. ` +
        `Bootstrap scripts expect a single-key account; key-list accounts are not supported in v1.`,
    );
  }
  return { type: body.key._type, hex: body.key.key };
}
