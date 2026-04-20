// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * Runtime account registry — agent only post-pivot.
 *
 * See docs/DESIGN.md §3. Upstream `HederaMCPToolkit` takes a single `Client`;
 * the running server uses agent as its sole signing identity. Operator and
 * treasury are cold (bootstrap-only, offline ops) and must NOT be loaded
 * into the server process env — a WARN fires on startup if their keys are
 * present.
 *
 * Bootstrap scripts (`scripts/bootstrap-*.ts`) load operator / treasury
 * from their own env at invocation time — they're standalone scripts and
 * do not go through this module.
 */

import { log } from './logger.js';

export interface AgentAccount {
  /** Agent account ID (0.0.xxxxx). */
  accountId: string;
  /** ECDSA private key (hex-encoded DER or raw). */
  privateKey: string;
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val || val.trim() === '') {
    throw new Error(`Required env var missing: ${name}. See .env.example.`);
  }
  return val;
}

/**
 * Warn loudly if a cold-key env var is present in the server's runtime env.
 * Fires at startup; doesn't block. The WARN is the ops signal — if it
 * shows up in prod logs, someone populated the wrong env file.
 */
function warnIfColdKeyLeaked(envName: string, role: string): void {
  if (process.env[envName] && process.env[envName]?.trim() !== '') {
    log.warn(
      `Cold-key env var present in server runtime env — this breaks the "${role} stays cold" invariant. ` +
        `See docs/DESIGN.md §3. Remove from this env; keep it only in bootstrap-script env files.`,
      { env: envName, role },
    );
  }
}

/**
 * Load the agent account from env. Throws at startup if required env vars
 * are missing (fail-loud per §15). Also scans for cold-key leaks and warns.
 */
export function loadAgentAccount(): AgentAccount {
  // Cold-key invariant checks — WARN only, don't throw. Running server
  // should never see these, but if it does we want the log trail, not
  // a hard failure that obscures the underlying misconfiguration.
  warnIfColdKeyLeaked('HEDERA_OPERATOR_KEY', 'operator');
  warnIfColdKeyLeaked('HEDERA_XENI_TREASURY_KEY', 'xeni_treasury');

  return {
    accountId: requireEnv('HEDERA_AGENT_ID'),
    privateKey: requireEnv('HEDERA_AGENT_KEY'),
  };
}

/**
 * Load the Xeni treasury ACCOUNT ID from env. The account ID is a public
 * identifier and is safe in runtime env — only the private KEY triggers
 * the cold-key invariant. Used by read-only MCP tools like
 * `get_treasury_allowance_remaining` that query Mirror Node for the
 * (treasury → agent) allowance without ever signing on the treasury's behalf.
 *
 * See docs/DESIGN.md §3 for the ID-vs-KEY distinction.
 */
export function loadTreasuryAccountId(): string {
  return requireEnv('HEDERA_XENI_TREASURY_ID');
}
