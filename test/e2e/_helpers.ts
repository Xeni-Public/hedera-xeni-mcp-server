// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * Shared helpers for E2E tests that run against a real Hedera testnet
 * account (the `testnet-ci` env). These tests never run on every PR —
 * only on the nightly GitHub Actions job that has `TESTNET_CI_*` secrets
 * populated. See `.github/workflows/ci.yml` `e2e-nightly` + DESIGN.md §14.
 *
 * Local dev: developers can run `npm run test:e2e` with their own
 * testnet credentials exported in their shell. Missing credentials
 * ⇒ tests self-skip via `describeE2E()` below rather than failing hard.
 */

/**
 * Env vars required for ALL e2e tests (agent + network).
 * Additional test-specific vars (treasury, audit topic, env label) are
 * checked per-file.
 *
 * Operator credentials (`HEDERA_OPERATOR_ID` / `HEDERA_OPERATOR_KEY`) are
 * deliberately NOT in this list (issue #21). None of our E2E tests sign
 * anything on behalf of the operator: `bootstrap-idempotency.e2e.test.ts`
 * uses a manually-built `BootstrapEnv` on the idempotent re-use path
 * (throw-if-called stubs guard the create paths), and `audit-flow` /
 * `server-wiring` use the agent identity. Keeping operator credentials
 * out of the runtime env prevents `warnIfColdKeyLeaked()` from firing in
 * the E2E job and preserves the cold-key invariant end-to-end.
 */
const REQUIRED_BASE_ENV = ['HEDERA_AGENT_ID', 'HEDERA_AGENT_KEY', 'HEDERA_NETWORK'] as const;

/**
 * Returns the list of missing env vars. Empty array = all present.
 * `HEDERA_ENV_LABEL` is allowed to default (loadConfig assigns "dev"), so
 * it's not in the required list.
 */
export function missingBaseE2EEnv(): string[] {
  return REQUIRED_BASE_ENV.filter((k) => !process.env[k] || process.env[k]?.trim() === '');
}

/**
 * Returns the list of missing env vars for a given extra set. Used by
 * individual E2E files to check for their specific prerequisites (e.g.
 * audit-topic tests need `HEDERA_XENI_AUDIT_TOPIC_ID`).
 */
export function missingE2EEnv(extras: readonly string[] = []): string[] {
  const missingBase = missingBaseE2EEnv();
  const missingExtras = extras.filter((k) => !process.env[k] || process.env[k]?.trim() === '');
  return [...missingBase, ...missingExtras];
}
