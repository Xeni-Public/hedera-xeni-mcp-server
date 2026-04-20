// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * M3 — Create global `xeni_audit` HCS topic for a target environment.
 *
 * Standalone MIGRATION SCRIPT (per `feedback_migrations_standalone.md`).
 * Runs on an OPS LAPTOP, NOT on server startup. Anand invokes it manually
 * at cutover, validates the printed topic ID on HashScan, then pastes the
 * ID into the target env's `.env.<env>` as `HEDERA_XENI_AUDIT_TOPIC_ID`.
 *
 * Usage:
 *   npm run bootstrap:audit-topic
 *
 * Required env (see .env.example SECTION B):
 *   HEDERA_OPERATOR_ID       — operator account ID (admin key authority)
 *   HEDERA_OPERATOR_KEY      — operator ECDSA private key (signs topic-create tx)
 *   HEDERA_AGENT_ID          — agent account (runtime signer). Its public key
 *                              becomes the topic's submit_key so only the agent
 *                              can post audit messages at runtime.
 *   HEDERA_NETWORK           — "testnet" | "mainnet"
 *   HEDERA_ENV_LABEL         — "dev" | "testnet-ci" | "testnet-uat" | "mainnet-prod"
 *
 * Topic design (docs/DESIGN.md §5):
 *   - Memo: `xeni_audit_v1_<HEDERA_ENV_LABEL>` — doubles as idempotency key
 *     (re-runs find the existing topic via Mirror Node memo match rather
 *     than minting a duplicate).
 *   - Admin key: operator's public key — lets operator later rotate the
 *     submit key without recreating the topic (important for agent-key
 *     rotation scenarios).
 *   - Submit key: AGENT's public key — fetched from Mirror Node, not from
 *     env. Bootstrap env never holds the agent private key. At runtime,
 *     only the agent can submit; operator being cold is preserved.
 *
 * Output contract: one line to stdout in env-var format, so ops can pipe
 * the result straight into an env file if they want:
 *
 *   HEDERA_XENI_AUDIT_TOPIC_ID=0.0.xxxxxxx  # newly created | existing, unchanged
 *
 * All informational + error logs go to stderr (stdout is reserved for the
 * machine-parsable output line).
 */

import { pathToFileURL } from 'node:url';
import { Client, PublicKey, TopicCreateTransaction, type TopicId } from '@hiero-ledger/sdk';
import { loadBootstrapEnv, type BootstrapEnv } from './lib/bootstrapEnv.js';
import { fetchAccountPublicKey, findTopicByMemo, type HederaNetwork } from './lib/mirrorLookup.js';

/** Pure function: build the memo string for a given env label. */
export function auditTopicMemo(envLabel: string): string {
  return `xeni_audit_v1_${envLabel}`;
}

/**
 * Parse a Mirror Node public-key record into a Hiero SDK `PublicKey`.
 * Supports the two algorithms a Hedera account can use for its primary
 * key; key-list accounts are rejected upstream in `fetchAccountPublicKey`.
 */
export function parseMirrorPublicKey(keyType: string, keyHex: string): PublicKey {
  if (keyType === 'ECDSA_SECP256K1') return PublicKey.fromStringECDSA(keyHex);
  if (keyType === 'ED25519') return PublicKey.fromStringED25519(keyHex);
  throw new Error(
    `Unsupported Mirror Node key type: "${keyType}" (expected ECDSA_SECP256K1 or ED25519).`,
  );
}

/* v8 ignore start -- Trivial console-wrapping defaults; business logic uses the injected deps. */
function defaultLogStderr(message: string): void {
  // eslint-disable-next-line no-console -- scripts are allowed to log; stderr for info, stdout reserved for machine output
  console.error(message);
}

function defaultPrintOutput(topicId: string, note: string): void {
  // eslint-disable-next-line no-console -- scripts are allowed to log; this is the documented output contract
  console.log(`HEDERA_XENI_AUDIT_TOPIC_ID=${topicId}  # ${note}`);
}
/* v8 ignore stop */

/**
 * Minimal shape of the side-effects `runBootstrap` performs — extracted
 * as an interface so unit tests can inject fakes for Mirror Node lookups,
 * topic creation, and stdout/stderr without touching the SDK or env.
 *
 * In production use, `runCliBootstrap` below wires these to real
 * Mirror Node calls + Hiero SDK calls; in tests, each field is a mock.
 */
export interface BootstrapAuditTopicDeps {
  findTopicByMemo: (
    operatorId: string,
    memo: string,
    network: HederaNetwork,
  ) => Promise<string | null>;
  fetchAccountPublicKey: (
    accountId: string,
    network: HederaNetwork,
  ) => Promise<{ type: string; hex: string }>;
  /**
   * Create the topic. Takes the memo, admin key, and submit key and
   * returns the new topic ID + tx ID. In production, wraps
   * `TopicCreateTransaction(...).execute(client); .getReceipt()`.
   */
  createTopic: (args: {
    env: BootstrapEnv;
    memo: string;
    adminKey: PublicKey;
    submitKey: PublicKey;
  }) => Promise<{ topicId: string; transactionId: string }>;
  logStderr: (message: string) => void;
  printMachineOutput: (topicId: string, note: string) => void;
}

export interface RunBootstrapInput {
  env: BootstrapEnv;
  agentId: string;
}

/**
 * Core orchestration — testable without a real network or SDK client.
 * Splits the two paths (existing-topic / new-topic) so tests can exercise
 * both via injected deps. Returns the topic ID so callers / tests can
 * assert on it.
 *
 * Design rationale: `main()` being un-unit-testable because it reaches
 * for SDK + env directly would collapse bootstrap-script coverage below
 * threshold. DI here makes the happy path + idempotent-re-use path
 * explicitly covered without mocking the whole Hiero SDK.
 */
export async function runBootstrap(
  input: RunBootstrapInput,
  deps: BootstrapAuditTopicDeps,
): Promise<{ topicId: string; created: boolean }> {
  const { env, agentId } = input;
  const memo = auditTopicMemo(env.envLabel);

  deps.logStderr(
    `[bootstrap-audit-topic] env=${env.envLabel} network=${env.network} operator=${env.operatorId} agent=${agentId} memo="${memo}"`,
  );

  // ---- Idempotency preamble ----
  deps.logStderr(
    '[bootstrap-audit-topic] checking Mirror Node for existing topic with this memo...',
  );
  const existing = await deps.findTopicByMemo(env.operatorId, memo, env.network);
  if (existing) {
    deps.logStderr(
      `[bootstrap-audit-topic] found existing topic ${existing} — re-using, no new tx.`,
    );
    deps.printMachineOutput(existing, 'existing, unchanged');
    return { topicId: existing, created: false };
  }

  // ---- New topic path ----
  deps.logStderr(
    '[bootstrap-audit-topic] no existing topic; fetching agent public key for submit_key...',
  );
  const agentKeyRecord = await deps.fetchAccountPublicKey(agentId, env.network);
  const agentPublicKey = parseMirrorPublicKey(agentKeyRecord.type, agentKeyRecord.hex);
  deps.logStderr(`[bootstrap-audit-topic] agent public key type=${agentKeyRecord.type}, loaded.`);

  deps.logStderr('[bootstrap-audit-topic] submitting TopicCreateTransaction...');
  const { topicId, transactionId } = await deps.createTopic({
    env,
    memo,
    adminKey: env.operatorKey.publicKey,
    submitKey: agentPublicKey,
  });

  deps.logStderr(`[bootstrap-audit-topic] created topic ${topicId} — txId=${transactionId}`);
  deps.printMachineOutput(topicId, 'newly created');

  return { topicId, created: true };
}

/**
 * Production `createTopic` implementation — wraps the Hiero SDK call.
 * Separated out so the SDK surface is the only thing the unit tests don't
 * exercise (by design — SDK calls are E2E territory).
 *
 * Excluded from coverage via v8-ignore: its only logic is the SDK method
 * chain + a `null topicId` defensive throw, both of which are covered
 * meaningfully by E2E in PR #17, not by a mock-heavy unit test.
 */
/* v8 ignore start -- SDK wrapper; covered by E2E in PR #17 */
export async function createTopicViaSdk(args: {
  env: BootstrapEnv;
  memo: string;
  adminKey: PublicKey;
  submitKey: PublicKey;
}): Promise<{ topicId: string; transactionId: string }> {
  const client = Client.forName(args.env.network).setOperator(
    args.env.operatorId,
    args.env.operatorKey,
  );
  try {
    const tx = await new TopicCreateTransaction()
      .setTopicMemo(args.memo)
      .setAdminKey(args.adminKey)
      .setSubmitKey(args.submitKey)
      .execute(client);
    const receipt = await tx.getReceipt(client);
    const topicId: TopicId | null = receipt.topicId;
    if (!topicId) {
      throw new Error('TopicCreateTransaction receipt did not include a topicId — unexpected.');
    }
    return {
      topicId: topicId.toString(),
      transactionId: tx.transactionId?.toString() ?? 'unknown',
    };
  } finally {
    // Close the client so the process exits cleanly (no lingering gRPC).
    client.close();
  }
}
/* v8 ignore stop */

/* v8 ignore start -- CLI wiring; exercises env + real deps, covered by E2E in PR #17 */
async function main(): Promise<void> {
  const env = loadBootstrapEnv();
  const agentId = process.env['HEDERA_AGENT_ID'];
  if (!agentId || agentId.trim() === '') {
    throw new Error(
      'Required env var missing: HEDERA_AGENT_ID. The agent public key is fetched ' +
        'from Mirror Node and used as the topic submit_key.',
    );
  }

  await runBootstrap(
    { env, agentId },
    {
      findTopicByMemo,
      fetchAccountPublicKey,
      createTopic: createTopicViaSdk,
      logStderr: defaultLogStderr,
      printMachineOutput: defaultPrintOutput,
    },
  );
}
/* v8 ignore stop */

/* v8 ignore start -- CLI entry point; invocation-scope, tested via E2E in PR #17 */
// ESM entry-point guard: only run `main()` when this file is executed
// directly via `tsx` / `node`, not when imported by unit tests. Same
// pattern as `src/transports/http.ts`.
const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  main().catch((err: unknown) => {
    defaultLogStderr(`[ERROR] bootstrap-audit-topic failed: ${String(err)}`);
    process.exit(1);
  });
}
/* v8 ignore stop */
