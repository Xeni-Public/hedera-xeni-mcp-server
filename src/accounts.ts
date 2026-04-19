// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * Account registry — role → Hedera account mapping.
 *
 * See docs/DESIGN.md §3. Three roles in v1: operator, agent, xeni_treasury.
 * Keys are loaded from env at startup. The `xeni_treasury` key is NOT loaded
 * here — it's cold (ops-laptop-signed), never in server process env.
 *
 * Future-proof: the registry abstraction accepts customer_accounts[] and
 * supplier_accounts[] entries for Phase 4/5 without code changes — just config.
 */

// TODO: import AccountId, PrivateKey from '@hiero-ledger/sdk' after first install

export type Role = 'operator' | 'agent' | 'xeni_treasury';

export interface RoleAccount {
  role: Role;
  accountId: string; // 0.0.xxxxx
  // Private key present only for roles the server signs with.
  // xeni_treasury key is NEVER loaded here — see design doc §3 P1.
  privateKey?: string;
}

export interface AccountRegistry {
  get(role: Role): RoleAccount;
  has(role: Role): boolean;
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val || val.trim() === '') {
    throw new Error(`Required env var missing: ${name}. See .env.example.`);
  }
  return val;
}

/**
 * Build the registry from env. Throws at startup if required env vars are
 * missing — fail-loud per §15 migration rule ("server never auto-creates").
 */
export function buildAccountRegistry(): AccountRegistry {
  const operator: RoleAccount = {
    role: 'operator',
    accountId: requireEnv('HEDERA_OPERATOR_ID'),
    privateKey: requireEnv('HEDERA_OPERATOR_KEY'),
  };

  const agent: RoleAccount = {
    role: 'agent',
    accountId: requireEnv('HEDERA_AGENT_ID'),
    privateKey: requireEnv('HEDERA_AGENT_KEY'),
  };

  // Treasury: account ID only (key is cold — see docs/DESIGN.md §3 + RUNBOOKS).
  const treasury: RoleAccount = {
    role: 'xeni_treasury',
    accountId: requireEnv('HEDERA_XENI_TREASURY_ID'),
  };

  const map = new Map<Role, RoleAccount>([
    ['operator', operator],
    ['agent', agent],
    ['xeni_treasury', treasury],
  ]);

  return {
    get(role: Role): RoleAccount {
      const a = map.get(role);
      if (!a) throw new Error(`Role not configured: ${role}`);
      return a;
    },
    has(role: Role): boolean {
      return map.has(role);
    },
  };
}
