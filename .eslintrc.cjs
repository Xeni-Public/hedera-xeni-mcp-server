// Authored-by: Anand Palanisamy - anand@xeni.com

/* eslint-env node */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    // Use a wider tsconfig for ESLint so test/ files are covered without
    // also emitting them as part of `tsc -p tsconfig.json` build output.
    project: './tsconfig.eslint.json',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:@typescript-eslint/recommended-requiring-type-checking',
  ],
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/consistent-type-imports': 'error',
    '@typescript-eslint/no-floating-promises': 'error',
    'no-console': ['warn', { allow: ['error'] }],
    // Warn (not fail) on TODO(pN:) comments so CI surfaces unresolved polish items
    // without blocking merge. Implementation PRs are expected to resolve these.
    'no-warning-comments': [
      'warn',
      { terms: ['todo(p1)', 'todo(p2)', 'todo(p3)', 'todo(p4)', 'todo(p5)'], location: 'anywhere' },
    ],
  },
  ignorePatterns: ['dist/', 'node_modules/', 'coverage/', '*.cjs'],
};
