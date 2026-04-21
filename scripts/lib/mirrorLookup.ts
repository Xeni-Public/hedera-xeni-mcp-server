// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * Mirror Node lookups used by bootstrap scripts.
 *
 * Three operations:
 *   - `fetchTopicMemo(topicId, network)` — idempotency verification for M3.
 *     Given a pre-configured `HEDERA_XENI_AUDIT_TOPIC_ID`, fetches the
 *     topic's current memo so `runBootstrap` can assert it matches the
 *     expected `xeni_audit_v1_<env>` pattern.
 *   - `fetchAccountMemo(accountId, network)` — same shape for M4's
 *     `HEDERA_XENI_TREASURY_ID` verification.
 *   - `fetchAccountPublicKey(accountId, network)` — M3 needs the agent's
 *     public key to set as the topic's `submit_key`. Rather than requiring
 *     the bootstrap env to carry the agent's private key (distinct cold-key
 *     concern), we look it up from Mirror Node — public by definition.
 *
 * NOTE (issue #18): the previous `findTopicByMemo` function has been
 * removed. It hit a non-existent Mirror Node endpoint
 * (`/api/v1/topics?account.id=...`) that returned 404 on any real call.
 * Unit tests mocked the fetch response shape and missed the bug.
 * Replacement strategy mirrors M4: ops sets `HEDERA_XENI_AUDIT_TOPIC_ID`
 * in env, the bootstrap script verifies its memo via `fetchTopicMemo`.
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
 * Mirror Node /api/v1/topics/{id} response — only the fields we use.
 * `admin_key` and `submit_key` shape is documented but not consumed here
 * (bootstrap verification only needs the memo).
 * See https://docs.hedera.com/hedera/mirror-node-api/rest-api
 */
interface MirrorTopicInfo {
  topic_id?: string;
  memo?: string;
  admin_key?: { _type: string; key: string } | null;
  submit_key?: { _type: string; key: string } | null;
}

/**
 * Fetch a topic's memo from Mirror Node. Returns the memo string, or
 * `null` if the topic exists but has no memo. Throws if the topic
 * doesn't exist (HTTP 404 bubbles up as a Mirror Node error).
 *
 * Parallel shape to `fetchAccountMemo`. Used by M3 bootstrap to VERIFY
 * that a pre-configured `HEDERA_XENI_AUDIT_TOPIC_ID` actually points to
 * a Xeni-bootstrapped audit topic (memo matches `xeni_audit_v1_<env>`) —
 * catches the footgun where ops pastes a wrong topic ID into the env.
 *
 * This is the correct replacement for the removed `findTopicByMemo`
 * (issue #18): it hits `/api/v1/topics/{id}` (a real Mirror Node
 * endpoint) rather than the fictional `/api/v1/topics?account.id=...`.
 */
export async function fetchTopicMemo(
  topicId: string,
  network: HederaNetwork,
  options: LookupOptions = {},
): Promise<string | null> {
  const baseUrl = options.baseUrl ?? mirrorNodeBaseUrl(network);
  const url = `${baseUrl}/api/v1/topics/${encodeURIComponent(topicId)}`;
  const body = (await fetchJson(url, options)) as MirrorTopicInfo;

  if (!body || typeof body !== 'object') {
    throw new Error(`Mirror Node /topics/${topicId} returned non-object body.`);
  }
  return typeof body.memo === 'string' ? body.memo : null;
}

/**
 * Mirror Node /api/v1/accounts/{id} response — only the fields we use.
 * `key._type` names the algorithm (e.g. "ECDSA_SECP256K1", "ED25519");
 * `key.key` is the hex-encoded public key suitable for Hiero SDK parsing.
 */
interface MirrorAccountInfo {
  account?: string;
  memo?: string;
  key?: { _type: string; key: string } | null;
}

/**
 * Fetch an account's memo from Mirror Node. Returns the memo string, or
 * `null` if the account exists but has no memo. Throws if the account
 * doesn't exist (HTTP 404 bubbles up as a Mirror Node error).
 *
 * Used by M4 bootstrap to VERIFY that a pre-configured
 * `HEDERA_XENI_TREASURY_ID` actually points to a Xeni-bootstrapped
 * treasury (memo matches `xeni_treasury_v1_<env>`) — catches the
 * footgun where ops pastes a wrong account ID into the env.
 */
export async function fetchAccountMemo(
  accountId: string,
  network: HederaNetwork,
  options: LookupOptions = {},
): Promise<string | null> {
  const baseUrl = options.baseUrl ?? mirrorNodeBaseUrl(network);
  const url = `${baseUrl}/api/v1/accounts/${encodeURIComponent(accountId)}`;
  const body = (await fetchJson(url, options)) as MirrorAccountInfo;

  if (!body || typeof body !== 'object') {
    throw new Error(`Mirror Node /accounts/${accountId} returned non-object body.`);
  }
  return typeof body.memo === 'string' ? body.memo : null;
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
