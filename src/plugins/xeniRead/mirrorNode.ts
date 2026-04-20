// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * Mirror Node REST helper for Xeni read tools.
 *
 * Thin wrapper around the public Hedera Mirror Node REST API. Used by
 * `get_treasury_allowance_remaining` (and future read tools) to answer
 * questions AgentService asks about on-chain state without AgentService
 * touching Mirror Node directly. Consumer: the Xeni read-plugin tool
 * handlers. See docs/DESIGN.md §6 (MCP is the single gateway to Hedera).
 *
 * Invariants:
 *   - 5s timeout by default (AgentService-side guard fails closed on any
 *     error, so don't swallow — throw clearly)
 *   - One attempt per call; retry/backoff is AgentService's concern
 *   - Structured error messages name the failure mode (network / HTTP /
 *     parse) so a caller reading the error log knows which layer broke
 */

export type HederaNetwork = 'testnet' | 'mainnet';

/**
 * Canonical public Mirror Node base URLs.
 *
 * Kept as a literal map (not derived from `client.ledgerId`) because
 * (a) the mapping is stable and publicly documented, and (b) it lets
 * this module stand alone without importing `@hiero-ledger/sdk`, which
 * keeps unit tests fast.
 */
const MIRROR_NODE_URLS: Record<HederaNetwork, string> = {
  testnet: 'https://testnet.mirrornode.hedera.com',
  mainnet: 'https://mainnet-public.mirrornode.hedera.com',
};

/**
 * Return the Mirror Node base URL for a given network. Throws on unknown
 * network (defensive — `ServerConfig.network` is typed, but env parsing
 * could still produce an unexpected value if `HEDERA_NETWORK` is set to
 * something off-menu).
 */
export function mirrorNodeBaseUrl(network: string): string {
  const url = MIRROR_NODE_URLS[network as HederaNetwork];
  if (!url) {
    throw new Error(`Unknown Hedera network: "${network}". Expected "testnet" or "mainnet".`);
  }
  return url;
}

/**
 * Shape of a single crypto-allowance entry in the Mirror Node response.
 * `amount` is the CURRENT remaining tinybar; `amount_granted` is the
 * original grant. We care about `amount` for the "remaining" query.
 * See https://docs.hedera.com/hedera/mirror-node-api/rest-api
 */
export interface MirrorCryptoAllowance {
  amount: number;
  amount_granted: number;
  owner: string;
  spender: string;
  timestamp: { from: string; to: string | null };
}

export interface MirrorCryptoAllowanceResponse {
  allowances: MirrorCryptoAllowance[];
  links: { next: string | null };
}

/**
 * Dependency-injected `fetch`. Tests pass a mock; prod uses global fetch.
 * Typing is the Web-standard `fetch` signature.
 */
export type FetchFn = (input: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export interface FetchCryptoAllowancesOptions {
  /** Base URL (override of `mirrorNodeBaseUrl(network)`) — useful for tests. */
  baseUrl?: string;
  /** Request timeout in ms. Default 5000. */
  timeoutMs?: number;
  /** Fetch implementation. Default: global fetch. */
  fetchImpl?: FetchFn;
}

/**
 * Fetch crypto allowances from Mirror Node for the given (owner → spender)
 * pair. Returns the raw JSON body. Throws on network error, HTTP non-2xx,
 * timeout, or JSON parse failure — each with a descriptive message
 * identifying which layer failed (so an AgentService guard reading the
 * error log can tell Mirror-Node-5xx from agent-misconfiguration).
 *
 * @param network       - "testnet" or "mainnet"; selects the default base URL
 * @param ownerAccountId   - the account that GRANTED the allowance (treasury)
 * @param spenderAccountId - the account RECEIVING the allowance (agent)
 * @param options       - overrides for baseUrl / timeout / fetch (tests)
 */
export async function fetchCryptoAllowances(
  network: string,
  ownerAccountId: string,
  spenderAccountId: string,
  options: FetchCryptoAllowancesOptions = {},
): Promise<MirrorCryptoAllowanceResponse> {
  const baseUrl = options.baseUrl ?? mirrorNodeBaseUrl(network);
  const timeoutMs = options.timeoutMs ?? 5000;
  const fetchImpl = options.fetchImpl ?? fetch;

  const url = `${baseUrl}/api/v1/accounts/${encodeURIComponent(ownerAccountId)}/allowances/crypto?spender.id=${encodeURIComponent(spenderAccountId)}`;

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

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new Error(`Mirror Node returned invalid JSON: ${String(err)}`);
  }

  // Defensive shape check — the upstream API has been stable, but a bad
  // response would otherwise propagate as `undefined.allowances.reduce(...)`
  // at the caller, which is a much worse error message than this.
  if (
    typeof body !== 'object' ||
    body === null ||
    !Array.isArray((body as MirrorCryptoAllowanceResponse).allowances)
  ) {
    throw new Error(
      `Mirror Node response missing "allowances" array: ${JSON.stringify(body).slice(0, 200)}`,
    );
  }

  return body as MirrorCryptoAllowanceResponse;
}

/**
 * Sum the `amount` (remaining tinybar) across all crypto-allowance entries.
 * Typically Mirror Node returns one entry per (owner, spender) pair, but
 * sum defensively so multiple entries don't silently under-count.
 * Returns 0 when the allowances array is empty (no grants exist yet —
 * e.g. before M4 bootstrap-treasury has run for a fresh env).
 *
 * Throws with a clear message if `amount` is not an integer — tinybar is
 * integer on-chain, so a fractional value indicates a Mirror Node
 * response-shape surprise we want to know about (rather than silently
 * truncate and under-count). Matches the rest of this module's fail-loud
 * stance on shape surprises.
 */
export function sumRemainingTinybar(response: MirrorCryptoAllowanceResponse): bigint {
  let total = 0n;
  for (const a of response.allowances) {
    if (!Number.isInteger(a.amount)) {
      throw new Error(
        `Mirror Node returned non-integer tinybar amount: ${a.amount} ` +
          `(owner=${a.owner} spender=${a.spender}). Tinybar is integer on-chain; ` +
          `a fractional value indicates an upstream shape change worth investigating.`,
      );
    }
    total += BigInt(a.amount);
  }
  return total;
}
