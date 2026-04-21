// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * Regression guard for `.github/workflows/ci.yml` (issue #21 O1).
 *
 * Companion to `test/unit/e2eHelpers.test.ts`: that file locks the
 * test-side drift (`REQUIRED_BASE_ENV` must not demand operator creds);
 * this file locks the workflow-side drift (the e2e-nightly env block
 * must not provide them). Together they close the regression loop — if
 * someone re-adds `HEDERA_OPERATOR_KEY: ${{ secrets.TESTNET_CI_OPERATOR_KEY }}`
 * to ci.yml, this test fails loudly rather than silently re-opening #21.
 *
 * The regex matches indented `ENV_NAME:` patterns (YAML key assignment)
 * but NOT comment lines that reference the name — comments start with
 * `#` and don't have a colon-terminator against the env var.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dirName = path.dirname(fileURLToPath(import.meta.url));
const CI_WORKFLOW_PATH = path.resolve(dirName, '../../.github/workflows/ci.yml');

describe('ci.yml / cold-key invariant (issue #21)', () => {
  const ciYaml = readFileSync(CI_WORKFLOW_PATH, 'utf8');

  it('does not assign HEDERA_OPERATOR_KEY as an env var anywhere in the workflow', () => {
    // Matches an env-var assignment like `          HEDERA_OPERATOR_KEY: ...`
    // Start-of-line + whitespace + name + colon. Comments (`# HEDERA_OPERATOR_KEY`)
    // never have the `:` directly after the name so they don't match.
    expect(ciYaml).not.toMatch(/^\s+HEDERA_OPERATOR_KEY:/m);
  });

  it('does not assign HEDERA_OPERATOR_ID as an env var anywhere in the workflow', () => {
    expect(ciYaml).not.toMatch(/^\s+HEDERA_OPERATOR_ID:/m);
  });

  it('still references the issue-#21 explanation so drift-by-review sees the rationale', () => {
    // If someone reverts the removal, they'll have to also delete this
    // comment — at which point the intent of the change is obvious in
    // the diff. Belt-and-braces against silent drift.
    expect(ciYaml).toMatch(/issue #21/i);
  });
});
