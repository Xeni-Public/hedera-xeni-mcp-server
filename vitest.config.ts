// Authored-by: Anand Palanisamy - anand@xeni.com

import { defineConfig } from 'vitest/config';

// §14 Testing strategy:
//   unit + reference-impl specs: runs on every PR (required gate)
//   integration:                 runs on every PR (required gate)
//   e2e:                         runs nightly on testnet-ci (not per-PR; testnet HBAR cost + latency)
//
// Post-pivot (PR #9): reference-impl/tests/ tests run alongside MCP unit tests.
// They validate the behavioral contracts AgentService's Go port must match.
export default defineConfig({
  test: {
    include: [
      'test/unit/**/*.test.ts',
      'test/integration/**/*.test.ts',
      'reference-impl/tests/**/*.test.ts',
    ],
    exclude: ['test/e2e/**', 'node_modules/', 'dist/'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      // Coverage is scoped to reference-impl/ — the MCP runtime code in src/
      // is skeletal as of PR #9 (real wiring lands PR #10). Once src/server.ts
      // + transports wire up in PR #10, add `src/**/*.ts` here and tighten.
      //
      // reference-impl files maintain 100% coverage — they're behavioral specs
      // for the Go port; any uncovered code is a spec-gap risk.
      include: [
        // MCP runtime modules (tested via test/integration/ as of PR #11)
        'src/accounts.ts',
        'src/logger.ts',
        'src/server.ts',
        // HTTP transport (tested via test/integration/http-transport.test.ts as of PR #12)
        'src/transports/http.ts',
        // reference-impl specs (behavioral contracts for AgentService Go port)
        'reference-impl/hbar.ts',
        'reference-impl/hooks/auditEnvelopeBuilder.ts',
        'reference-impl/hooks/mandateBudgetGuard.ts',
        'reference-impl/hooks/spendPolicyGuard.ts',
        'reference-impl/hooks/treasuryAllowanceGuard.ts',
        'reference-impl/policies/accountResolver.ts',
      ],
      exclude: ['**/*.d.ts', '**/index.ts'],
      thresholds: {
        // §14: ≥80% coverage; reference-impl files typically run at 100%
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
    },
    globals: false,
  },
});
