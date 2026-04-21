// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * Mirror Node endpoint smoke-check primitives (issue #22).
 *
 * Pure-logic helpers for the pre-flight probe that runs before the
 * nightly E2E. Each Mirror Node endpoint we depend on gets a probe with:
 *   - full URL (built from a known Hedera ID we already ship for E2E)
 *   - classification (`prod-path` vs `test-infra`) — drives the failure
 *     message so on-call can triage severity at a glance
 *   - shape invariant — asserts the response body contains the specific
 *     field(s) our callers consume, not just a bare 200 + JSON. Issue #18
 *     was a 404 caught by E2E; a shape-shift (e.g. Mirror Node renaming
 *     `topic_id` → `topicId`) would return 200 but break us silently, so
 *     the invariant check is the real defense.
 *
 * Retry policy per Lead Buddy's Q5 on the issue thread: 3 attempts, 5s
 * apart, serial. No outer wrapper. ~60s worst-case for four endpoints.
 *
 * All IO (fetch, sleep) is injected so unit tests don't touch the network.
 */

import { mirrorNodeBaseUrl, type HederaNetwork } from './mirrorLookup.js';

/** Shape-invariant assertion — throws with a short reason on mismatch. */
export type ShapeAssertion = (body: unknown) => void;

export type ProbeClassification = 'prod-path' | 'test-infra';

export interface EndpointProbe {
  /** Human-readable endpoint label (e.g. `GET /api/v1/topics/{id}`). */
  label: string;
  /** Fully-resolved URL to hit. */
  url: string;
  /** Severity classification; drives the `[prod-path]` / `[test-infra]` prefix. */
  classification: ProbeClassification;
  /** Shape assertion invoked on the parsed response body. */
  shape: ShapeAssertion;
}

/** Injected IO + tuning for unit tests. */
export interface ProbeDeps {
  fetchImpl?: (input: string, init?: { signal?: AbortSignal }) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  /** Attempts per endpoint. Defaults to 3 (Q5). */
  attempts?: number;
  /** Delay between attempts, ms. Defaults to 5000 (Q5). */
  delayMs?: number;
  /** Per-attempt HTTP timeout, ms. Defaults to 5000. */
  timeoutMs?: number;
}

export interface ProbeResult {
  ok: boolean;
  attempts: number;
  /** Populated when `ok` is false. Pre-formatted with classification prefix. */
  errorMessage?: string;
}

/**
 * Probe one endpoint with retry. Returns `ok: true` if any attempt passes;
 * otherwise returns a formatted `errorMessage` per Lead Buddy's refinement:
 *
 *   SMOKE FAIL [prod-path]: GET /api/v1/topics/0.0.X — HTTP 404 after 3 attempts
 *   SMOKE FAIL [prod-path]: GET /api/v1/topics/0.0.X — shape assertion: missing 'topic_id'
 *
 * Retries uniformly on any failure (network, non-2xx, JSON parse, shape
 * mismatch). Retrying a 404 three times doesn't recover it — but it does
 * let us ride out genuinely transient blips (testnet indexers occasionally
 * hiccup on the edge of a consensus round).
 */
/* v8 ignore start -- trivial default wrappers; real fetch + setTimeout are exercised via the CLI + nightly workflow */
function defaultFetch(input: string, init?: { signal?: AbortSignal }): Promise<Response> {
  return fetch(input, init);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
/* v8 ignore stop */

export async function probeEndpoint(
  probe: EndpointProbe,
  deps: ProbeDeps = {},
): Promise<ProbeResult> {
  const fetchImpl = deps.fetchImpl ?? defaultFetch;
  const sleep = deps.sleep ?? defaultSleep;
  const attempts = deps.attempts ?? 3;
  const delayMs = deps.delayMs ?? 5000;
  const timeoutMs = deps.timeoutMs ?? 5000;

  let lastReason = '(no attempts made)';
  for (let i = 1; i <= attempts; i++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(probe.url, { signal: controller.signal });
        if (!res.ok) {
          lastReason = `HTTP ${res.status}`;
        } else {
          const body = await res.json();
          probe.shape(body);
          return { ok: true, attempts: i };
        }
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      lastReason = err instanceof Error ? err.message : String(err);
    }
    if (i < attempts) await sleep(delayMs);
  }
  return {
    ok: false,
    attempts,
    errorMessage: `SMOKE FAIL [${probe.classification}]: ${probe.label} — ${lastReason} after ${attempts} attempts`,
  };
}

// ----- Shape assertions -----
// Each asserts the specific field(s) our callers consume. Keep these
// narrow: we want to catch "Mirror Node changed the shape" but not
// false-positive on additive schema changes (new fields appearing).

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

/** `GET /api/v1/topics/{id}` — `fetchTopicMemo` reads `body.memo`; a valid response always carries `topic_id`. */
export function assertTopicShape(body: unknown): void {
  if (!isObject(body) || typeof body.topic_id !== 'string') {
    throw new Error("shape assertion: missing 'topic_id'");
  }
}

/** `GET /api/v1/accounts/{id}` — `fetchAccountMemo` + `fetchAccountPublicKey` both depend on this payload carrying `account`. */
export function assertAccountShape(body: unknown): void {
  if (!isObject(body) || typeof body.account !== 'string') {
    throw new Error("shape assertion: missing 'account'");
  }
}

/** `GET /api/v1/accounts/{id}/allowances/crypto` — `get_treasury_allowance_remaining` reduces over `body.allowances`. */
export function assertAllowancesShape(body: unknown): void {
  if (!isObject(body) || !Array.isArray(body.allowances)) {
    throw new Error("shape assertion: missing 'allowances' array");
  }
}

/** `GET /api/v1/topics/{id}/messages` — `audit-flow.e2e.test.ts` polls this payload's `body.messages` array. */
export function assertMessagesShape(body: unknown): void {
  if (!isObject(body) || !Array.isArray(body.messages)) {
    throw new Error("shape assertion: missing 'messages' array");
  }
}

// ----- Probe set builder -----

export interface BuildProbesInput {
  network: HederaNetwork;
  /** Existing testnet-ci topic ID — used for endpoints #1 and #4. */
  topicId: string;
  /** Existing agent account ID — used as spender for #2 and #3. */
  agentAccountId: string;
  /** Existing treasury account ID — used as owner for #3. */
  treasuryAccountId: string;
}

/**
 * Build the full probe set from known Hedera IDs. Prod-path probes run
 * first; test-infra probe runs last. Order matters for log readability
 * on failure, not for correctness (each probe is independent).
 */
export function buildProbes(input: BuildProbesInput): EndpointProbe[] {
  const base = mirrorNodeBaseUrl(input.network);
  const topic = encodeURIComponent(input.topicId);
  const agent = encodeURIComponent(input.agentAccountId);
  const treasury = encodeURIComponent(input.treasuryAccountId);

  return [
    {
      label: `GET /api/v1/topics/${input.topicId}`,
      url: `${base}/api/v1/topics/${topic}`,
      classification: 'prod-path',
      shape: assertTopicShape,
    },
    {
      label: `GET /api/v1/accounts/${input.agentAccountId}`,
      url: `${base}/api/v1/accounts/${agent}`,
      classification: 'prod-path',
      shape: assertAccountShape,
    },
    {
      label: `GET /api/v1/accounts/${input.treasuryAccountId}/allowances/crypto?spender.id=${input.agentAccountId}`,
      url: `${base}/api/v1/accounts/${treasury}/allowances/crypto?spender.id=${agent}`,
      classification: 'prod-path',
      shape: assertAllowancesShape,
    },
    {
      label: `GET /api/v1/topics/${input.topicId}/messages`,
      url: `${base}/api/v1/topics/${topic}/messages?order=desc&limit=50`,
      classification: 'test-infra',
      shape: assertMessagesShape,
    },
  ];
}
