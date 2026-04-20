// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * M4 — Bootstrap the Xeni treasury account + initial treasury→agent
 * refund allowance for a target environment.
 *
 * Standalone MIGRATION SCRIPT (per `feedback_migrations_standalone.md`).
 * Runs on an OPS LAPTOP, NOT on server startup. Anand invokes it manually
 * at cutover; the script outputs the new treasury account ID and its COLD
 * PRIVATE KEY to stdout. Ops saves the key to offline storage (HSM /
 * hardware wallet / laptop secure vault), pastes the ID into the target
 * env's `.env.<env>`, and NEVER puts the key into the server env.
 *
 * Usage:
 *   npm run bootstrap:treasury
 *
 * Required env (see .env.example SECTION B):
 *   HEDERA_OPERATOR_ID       — pays for account-create + allowance tx fees
 *   HEDERA_OPERATOR_KEY      — operator ECDSA private key (signs the create tx)
 *   HEDERA_AGENT_ID          — spender of the allowance (runtime signer)
 *   HEDERA_NETWORK           — "testnet" | "mainnet"
 *   HEDERA_ENV_LABEL         — "dev" | "testnet-ci" | "testnet-uat" | "mainnet-prod"
 *
 * Optional env (defaults applied if unset):
 *   HEDERA_XENI_TREASURY_INITIAL_BALANCE_HBAR  — default 30000 (3x daily cap per DESIGN.md §4)
 *   HEDERA_XENI_TREASURY_INITIAL_ALLOWANCE_HBAR — default 10000 (matches DESIGN.md §4 example daily cap)
 *
 * Idempotency:
 *   The script uses the bootstrap env var `HEDERA_XENI_TREASURY_ID` as its
 *   source-of-truth for "already bootstrapped":
 *     - If set: fetch the account's memo from Mirror Node. If the memo
 *       matches `xeni_treasury_v1_<env>`, print the ID (unchanged) and
 *       exit 0. If the memo doesn't match, throw loudly — ops almost
 *       certainly pasted a wrong account ID into the env.
 *     - If unset: create a fresh treasury + grant allowance.
 *
 *   Why not walk Mirror Node accounts for memo match (like M3 does for
 *   topics): there's no `creator.id` scope for the /accounts endpoint,
 *   so we'd have to walk ALL accounts on testnet/mainnet (millions) —
 *   infeasible. The env-var check is what ops has on their laptop anyway.
 *
 * Output contract: env-var-format stdout lines (machine-parsable), plus
 * progress + warnings on stderr. Existing-case:
 *
 *   HEDERA_XENI_TREASURY_ID=0.0.xxxxxxx  # existing, unchanged
 *
 * New-case (newly bootstrapped — key printed ONCE, here only):
 *
 *   HEDERA_XENI_TREASURY_ID=0.0.xxxxxxx  # newly created
 *   # ======================================================================
 *   # COLD KEY — save to offline storage IMMEDIATELY. This is the ONLY time
 *   # it will be printed. Never commit this line. Never put it in the
 *   # server's runtime env — src/accounts.ts warns if it sees
 *   # HEDERA_XENI_TREASURY_KEY at runtime (cold-key invariant).
 *   # ======================================================================
 *   HEDERA_XENI_TREASURY_KEY=302e...
 *   # Initial allowance: NNNN HBAR, spender=0.0.xxxxxxx
 */

import { pathToFileURL } from 'node:url';
import {
  AccountAllowanceApproveTransaction,
  AccountCreateTransaction,
  Client,
  Hbar,
  PrivateKey,
  type AccountId,
} from '@hiero-ledger/sdk';
import { loadBootstrapEnv, type BootstrapEnv } from './lib/bootstrapEnv.js';
import { fetchAccountMemo, type HederaNetwork } from './lib/mirrorLookup.js';

/** Pure: canonical memo for a treasury account, doubles as a validity check on re-run. */
export function treasuryMemo(envLabel: string): string {
  return `xeni_treasury_v1_${envLabel}`;
}

/**
 * Pure: parse an optional HBAR amount env var. Returns the default if
 * unset; throws if present but not a positive finite number.
 */
export function parseHbarEnv(envName: string, defaultHbar: number): number {
  const raw = process.env[envName];
  if (!raw || raw.trim() === '') return defaultHbar;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${envName}="${raw}" is not a positive finite number.`);
  }
  return parsed;
}

/**
 * Side-effect interface for `runBootstrap`. All external operations
 * (Mirror Node, SDK writes, stdin/stdout, key generation) are injected
 * so unit tests can mock them cleanly. Production deps wire to the real
 * Mirror Node / Hiero SDK in `main()` below.
 */
export interface BootstrapTreasuryDeps {
  fetchAccountMemo: (accountId: string, network: HederaNetwork) => Promise<string | null>;
  createTreasury: (args: {
    env: BootstrapEnv;
    memo: string;
    treasuryKey: PrivateKey;
    initialBalanceHbar: number;
  }) => Promise<{ treasuryId: string; transactionId: string }>;
  grantAllowance: (args: {
    env: BootstrapEnv;
    treasuryId: string;
    treasuryKey: PrivateKey;
    agentId: string;
    allowanceHbar: number;
  }) => Promise<{ transactionId: string }>;
  /** Generate the treasury's private key. DI'd so tests use a fixed key. */
  generateKey: () => PrivateKey;
  logStderr: (message: string) => void;
  /** Write a line to stdout verbatim (machine-parsable output contract). */
  printStdout: (line: string) => void;
}

export interface RunBootstrapInput {
  env: BootstrapEnv;
  agentId: string;
  initialBalanceHbar: number;
  initialAllowanceHbar: number;
  /**
   * If already set in the ops env, bootstrap verifies it rather than
   * creating a new treasury. Unset = first-time bootstrap.
   */
  existingTreasuryId?: string;
}

/** Returned to caller + tests — describes what actually happened. */
export interface RunBootstrapResult {
  treasuryId: string;
  created: boolean;
  /** Only meaningful when `created === true`. */
  allowanceHbar: number;
}

/**
 * Core orchestration — DI'd so unit tests cover both paths (existing
 * re-use + new-bootstrap) without touching the Hiero SDK or a real
 * network. Mirrors the `runBootstrap` shape from M3's
 * `bootstrap-audit-topic.ts`.
 *
 * Three branches:
 *   1. existingTreasuryId + memo matches  → print ID, return created=false
 *   2. existingTreasuryId + memo mismatch → throw (wrong ID in env)
 *   3. no existingTreasuryId              → create, grant, print ID + cold key
 */
export async function runBootstrap(
  input: RunBootstrapInput,
  deps: BootstrapTreasuryDeps,
): Promise<RunBootstrapResult> {
  const memo = treasuryMemo(input.env.envLabel);
  deps.logStderr(
    `[bootstrap-treasury] env=${input.env.envLabel} network=${input.env.network} operator=${input.env.operatorId} agent=${input.agentId} memo="${memo}"`,
  );

  // ---- Idempotent re-use path (env var set) ----
  if (input.existingTreasuryId) {
    deps.logStderr(
      `[bootstrap-treasury] HEDERA_XENI_TREASURY_ID=${input.existingTreasuryId} already set — verifying via Mirror Node...`,
    );
    const foundMemo = await deps.fetchAccountMemo(input.existingTreasuryId, input.env.network);
    if (foundMemo !== memo) {
      throw new Error(
        `HEDERA_XENI_TREASURY_ID=${input.existingTreasuryId} exists but its memo is ${JSON.stringify(foundMemo)}, ` +
          `not the expected "${memo}". Either you pasted the wrong account ID into the env, or this is a ` +
          `different env's treasury. Refusing to proceed — clear HEDERA_XENI_TREASURY_ID and re-run to create ` +
          `a fresh treasury, or correct the ID in the env file.`,
      );
    }
    deps.logStderr(
      `[bootstrap-treasury] memo matches — treasury already bootstrapped for this env.`,
    );
    deps.printStdout(`HEDERA_XENI_TREASURY_ID=${input.existingTreasuryId}  # existing, unchanged`);
    deps.printStdout(
      `# Allowance state NOT checked by this script. To verify remaining allowance:`,
    );
    deps.printStdout(`#   MCP: call tool 'get_treasury_allowance_remaining' (no args) against the`);
    deps.printStdout(
      `#        running MCP server for this env — returns { remainingHbar: number }`,
    );
    deps.printStdout(
      `#   HashScan: https://hashscan.io/${input.env.network}/account/${input.existingTreasuryId}`,
    );
    deps.printStdout(`#            → Allowances tab → filter spender=<agent>`);
    deps.printStdout(`# For top-up procedure, see docs/RUNBOOKS.md § "Treasury replenishment".`);
    return {
      treasuryId: input.existingTreasuryId,
      created: false,
      allowanceHbar: 0,
    };
  }

  // ---- New bootstrap path (env var not set) ----
  deps.logStderr(
    '[bootstrap-treasury] no existing treasury in env; generating new key + account...',
  );

  if (input.initialAllowanceHbar > input.initialBalanceHbar) {
    // Allowance > balance is technically valid on Hedera (allowance is just
    // approval; it doesn't reserve funds), but it means the agent can
    // never spend the full allowance. Warn loudly so ops notices the
    // misconfig rather than debugging it during a real refund.
    deps.logStderr(
      `[bootstrap-treasury] WARN: allowance (${input.initialAllowanceHbar} HBAR) exceeds initial balance ` +
        `(${input.initialBalanceHbar} HBAR). Agent will be unable to spend beyond balance even though ` +
        `approval exists. Consider increasing HEDERA_XENI_TREASURY_INITIAL_BALANCE_HBAR.`,
    );
  }

  const treasuryKey = deps.generateKey();

  const { treasuryId } = await deps.createTreasury({
    env: input.env,
    memo,
    treasuryKey,
    initialBalanceHbar: input.initialBalanceHbar,
  });
  deps.logStderr(`[bootstrap-treasury] created treasury ${treasuryId} (memo="${memo}")`);

  // Partial-failure path: if allowance grant fails AFTER account creation,
  // treasury exists on-chain but has no allowance. Re-running the script
  // won't retry (env-var idempotency check would short-circuit on the
  // treasury ID). Surface the recovery path in the error log so ops has a
  // concrete next step — see docs/RUNBOOKS.md § "Allowance repair".
  try {
    await deps.grantAllowance({
      env: input.env,
      treasuryId,
      treasuryKey,
      agentId: input.agentId,
      allowanceHbar: input.initialAllowanceHbar,
    });
  } catch (err) {
    deps.logStderr(
      `[bootstrap-treasury] ERROR: allowance grant failed AFTER treasury ${treasuryId} was created. ` +
        `Treasury exists on-chain (balance ${input.initialBalanceHbar} HBAR) but has NO allowance ` +
        `granted to the agent. Re-running this script will NOT retry — the env-var idempotency check ` +
        `would find the treasury and skip creation. Recovery: see docs/RUNBOOKS.md § "Allowance repair ` +
        `(post-M4 partial failure)". Original error: ${String(err)}`,
    );
    throw err;
  }
  deps.logStderr(
    `[bootstrap-treasury] granted initial allowance: ${input.initialAllowanceHbar} HBAR, ` +
      `owner=${treasuryId}, spender=${input.agentId}`,
  );

  // ---- Machine-parsable stdout (cold key printed ONLY here) ----
  deps.printStdout(`HEDERA_XENI_TREASURY_ID=${treasuryId}  # newly created`);
  deps.printStdout(`# ======================================================================`);
  deps.printStdout(`# COLD KEY — save to offline storage IMMEDIATELY. This is the ONLY time`);
  deps.printStdout(`# it will be printed. Never commit this line. Never put it in the`);
  deps.printStdout(`# server's runtime env — the MCP warns if it sees HEDERA_XENI_TREASURY_KEY`);
  deps.printStdout(`# at runtime (cold-key invariant, docs/DESIGN.md §3).`);
  deps.printStdout(`#`);
  deps.printStdout(`# FOOTGUN: if you ran this with '> out.env' the key is now on local disk`);
  deps.printStdout(`# (and possibly synced to iCloud / Dropbox / Time Machine backup). Move`);
  deps.printStdout(`# the key to offline storage, then 'shred -u <file>' (Linux) or`);
  deps.printStdout(`# 'srm <file>' (macOS) to remove the local copy securely.`);
  deps.printStdout(`# ======================================================================`);
  deps.printStdout(`HEDERA_XENI_TREASURY_KEY=${treasuryKey.toStringRaw()}`);
  deps.printStdout(
    `# Initial allowance: ${input.initialAllowanceHbar} HBAR, spender=${input.agentId}`,
  );

  return {
    treasuryId,
    created: true,
    allowanceHbar: input.initialAllowanceHbar,
  };
}

/**
 * Production `createTreasury` — wraps the Hiero SDK account-create +
 * receipt flow. Separated so the orchestrator stays SDK-free.
 *
 * Excluded from coverage via v8-ignore: SDK method chain + defensive null
 * check, covered meaningfully by E2E in PR #17.
 */
/* v8 ignore start -- SDK wrapper; covered by E2E in PR #17 */
export async function createTreasuryViaSdk(args: {
  env: BootstrapEnv;
  memo: string;
  treasuryKey: PrivateKey;
  initialBalanceHbar: number;
}): Promise<{ treasuryId: string; transactionId: string }> {
  const client = Client.forName(args.env.network).setOperator(
    args.env.operatorId,
    args.env.operatorKey,
  );
  try {
    const tx = await new AccountCreateTransaction()
      .setKey(args.treasuryKey.publicKey)
      .setInitialBalance(new Hbar(args.initialBalanceHbar))
      .setAccountMemo(args.memo)
      .execute(client);
    const receipt = await tx.getReceipt(client);
    const accountId: AccountId | null = receipt.accountId;
    if (!accountId) {
      // `finally` below closes the client on both success AND throw —
      // no explicit client.close() needed here.
      throw new Error(
        'AccountCreateTransaction receipt did not include an accountId — unexpected.',
      );
    }
    return {
      treasuryId: accountId.toString(),
      transactionId: tx.transactionId?.toString() ?? 'unknown',
    };
  } finally {
    client.close();
  }
}
/* v8 ignore stop */

/**
 * Production `grantAllowance` — wraps the Hiero SDK allowance-approve
 * flow. Treasury signs (owner of the allowance), operator pays tx fees.
 */
/* v8 ignore start -- SDK wrapper; covered by E2E in PR #17 */
export async function grantAllowanceViaSdk(args: {
  env: BootstrapEnv;
  treasuryId: string;
  treasuryKey: PrivateKey;
  agentId: string;
  allowanceHbar: number;
}): Promise<{ transactionId: string }> {
  const client = Client.forName(args.env.network).setOperator(
    args.env.operatorId,
    args.env.operatorKey,
  );
  try {
    // `freezeWith` + `sign` are synchronous builder methods (return `this`);
    // only `execute` + `getReceipt` are async. Treasury is the owner of the
    // allowance and Hedera requires the owner's signature on the approval;
    // operator is the tx payer via `setOperator` above.
    const tx = await new AccountAllowanceApproveTransaction()
      .approveHbarAllowance(args.treasuryId, args.agentId, new Hbar(args.allowanceHbar))
      .freezeWith(client)
      .sign(args.treasuryKey)
      .then((signed) => signed.execute(client));
    await tx.getReceipt(client);
    return { transactionId: tx.transactionId?.toString() ?? 'unknown' };
  } finally {
    client.close();
  }
}
/* v8 ignore stop */

/* v8 ignore start -- Trivial console-wrapping defaults; business logic uses injected deps. */
function defaultLogStderr(message: string): void {
  // eslint-disable-next-line no-console -- scripts log; stderr for progress, stdout reserved for machine output
  console.error(message);
}

function defaultPrintStdout(line: string): void {
  // eslint-disable-next-line no-console -- scripts log; stdout is the documented output contract
  console.log(line);
}
/* v8 ignore stop */

/* v8 ignore start -- CLI glue; exercises env + real deps, covered by E2E in PR #17 */
async function main(): Promise<void> {
  const env = loadBootstrapEnv();
  const agentId = process.env['HEDERA_AGENT_ID'];
  if (!agentId || agentId.trim() === '') {
    throw new Error(
      'Required env var missing: HEDERA_AGENT_ID. The agent is the spender of the refund allowance.',
    );
  }

  const initialBalanceHbar = parseHbarEnv('HEDERA_XENI_TREASURY_INITIAL_BALANCE_HBAR', 30000);
  const initialAllowanceHbar = parseHbarEnv('HEDERA_XENI_TREASURY_INITIAL_ALLOWANCE_HBAR', 10000);

  const rawExisting = process.env['HEDERA_XENI_TREASURY_ID'];
  const existingTreasuryId =
    rawExisting && rawExisting.trim() !== '' ? rawExisting.trim() : undefined;

  await runBootstrap(
    {
      env,
      agentId,
      initialBalanceHbar,
      initialAllowanceHbar,
      ...(existingTreasuryId !== undefined ? { existingTreasuryId } : {}),
    },
    {
      fetchAccountMemo,
      createTreasury: createTreasuryViaSdk,
      grantAllowance: grantAllowanceViaSdk,
      generateKey: () => PrivateKey.generateECDSA(),
      logStderr: defaultLogStderr,
      printStdout: defaultPrintStdout,
    },
  );
}

// ESM entry-point guard — same pattern as scripts/bootstrap-audit-topic.ts.
const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  main().catch((err: unknown) => {
    defaultLogStderr(`[ERROR] bootstrap-treasury failed: ${String(err)}`);
    process.exit(1);
  });
}
/* v8 ignore stop */
