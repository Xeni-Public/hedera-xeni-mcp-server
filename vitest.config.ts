// Authored-by: Anand Palanisamy - anand@xeni.com

import { defineConfig } from 'vitest/config';

// §14 Testing strategy — three projects, different CI cadences:
//   unit:        runs on every PR          (required gate)
//   integration: runs on every PR          (required gate)
//   e2e:         runs nightly on testnet-ci (not per-PR; testnet HBAR cost + latency)
export default defineConfig({
  test: {
    // Project-based config requires vitest workspace setup; this is the minimal
    // single-config starting point. Implementation PR splits into three projects.
    include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts'],
    exclude: ['test/e2e/**', 'node_modules/', 'dist/'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      // Scaffold-state `include` is narrow on purpose: only the two fully-
      // implemented modules are in scope for the 80% gate today. Each
      // implementation PR MUST add its file(s) here as it lands its unit
      // tests. This keeps the gate meaningful (high threshold on tested
      // files) rather than faking it (low threshold on the whole tree).
      //
      // Target end state: `include: ['src/**/*.ts']` once all 4 hooks +
      // policy + server + transports + fee calculators have their tests.
      include: [
        'src/plugins/xeniIntentMandate/hooks/auditEnvelopeBuilder.ts',
        'src/plugins/xeniIntentMandate/hooks/spendPolicyGuard.ts',
        'src/plugins/xeniIntentMandate/policies/accountResolver.ts',
      ],
      exclude: ['src/**/*.d.ts', 'src/**/index.ts'],
      thresholds: {
        // §14: ≥80% coverage on hooks + policy (applied to `include` above)
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
    },
    globals: false,
  },
});
