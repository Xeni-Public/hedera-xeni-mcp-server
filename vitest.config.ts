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
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/**/index.ts'],
      thresholds: {
        // §14: ≥80% coverage on hooks + policy
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
    },
    globals: false,
  },
});
