// Authored-by: Anand Palanisamy - anand@xeni.com

import { defineConfig } from 'vitest/config';

/**
 * E2E test config — separate from the default `vitest.config.ts` so the
 * nightly-only E2E suite doesn't get picked up by `npm test` or coverage
 * runs. The default config EXCLUDES `test/e2e/**`; this config INCLUDES
 * only `test/e2e/**`. Used by `npm run test:e2e` via `vitest --config`.
 *
 * Per DESIGN.md §14 E2E row:
 *   - Runs nightly on testnet-ci (not per-PR — testnet HBAR cost + latency)
 *   - Exercises real Hedera testnet traffic
 *   - No coverage gate (different test scope from unit/integration)
 *
 * Individual test files self-skip (`describe.skipIf`) when testnet-ci
 * credentials are not present in env, so a developer running locally
 * without credentials sees "skipped" rather than a hard failure.
 */
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.e2e.test.ts'],
    exclude: ['node_modules/', 'dist/'],
    environment: 'node',
    // E2E tests hit real Hedera + Mirror Node — much longer than unit tests.
    // Individual tests set their own timeouts; this is the floor.
    testTimeout: 60_000,
    // Explicit: no coverage collection for E2E runs.
    coverage: {
      enabled: false,
    },
    globals: false,
  },
});
