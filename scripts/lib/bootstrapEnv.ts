// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * Shared environment loader for bootstrap scripts (M3 audit-topic, M4 treasury).
 *
 * Bootstrap scripts run on an OPS LAPTOP, not in the MCP server process.
 * They need operator credentials (cold key, loaded only at bootstrap time)
 * plus the target network + env label. This module centralizes env parsing
 * + validation so both scripts fail with the same clear error when
 * something is missing.
 *
 * Consumer: `scripts/bootstrap-*.ts`. Not imported by any `src/` code —
 * bootstrap env is a distinct concern from runtime env.
 */

import { PrivateKey } from '@hiero-ledger/sdk';

/** Required + validated env for a bootstrap script run. */
export interface BootstrapEnv {
  /** Operator account ID (e.g. `0.0.1001`). */
  operatorId: string;
  /** Parsed operator ECDSA private key — freezes any tx we submit. */
  operatorKey: PrivateKey;
  /** "testnet" or "mainnet". */
  network: 'testnet' | 'mainnet';
  /** Env label for the topic memo + log readability. */
  envLabel: string;
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val || val.trim() === '') {
    throw new Error(
      `Required env var missing: ${name}. See .env.example SECTION B for bootstrap-only vars.`,
    );
  }
  return val;
}

/**
 * Load + validate the bootstrap env. Throws loudly on missing / malformed
 * values so ops sees the specific problem before anything touches the
 * network.
 *
 * Accepted network values: `testnet` | `mainnet`. Anything else throws.
 */
export function loadBootstrapEnv(): BootstrapEnv {
  const operatorId = requireEnv('HEDERA_OPERATOR_ID');
  const rawOperatorKey = requireEnv('HEDERA_OPERATOR_KEY');

  // Parse the operator key at load time so malformed hex fails BEFORE we
  // start issuing transactions. Matches `src/server.ts`'s fail-loud stance
  // for `HEDERA_AGENT_KEY`.
  let operatorKey: PrivateKey;
  try {
    operatorKey = PrivateKey.fromStringECDSA(rawOperatorKey);
  } catch (err) {
    throw new Error(`HEDERA_OPERATOR_KEY is not a valid ECDSA private key: ${String(err)}`);
  }

  const rawNetwork = requireEnv('HEDERA_NETWORK');
  if (rawNetwork !== 'testnet' && rawNetwork !== 'mainnet') {
    throw new Error(`HEDERA_NETWORK must be "testnet" or "mainnet", got: "${rawNetwork}"`);
  }

  const envLabel = requireEnv('HEDERA_ENV_LABEL');

  return {
    operatorId,
    operatorKey,
    network: rawNetwork,
    envLabel,
  };
}
