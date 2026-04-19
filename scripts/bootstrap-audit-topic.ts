/**
 * M3 — Create global `xeni_audit` HCS topic for a target environment.
 *
 * This is a STANDALONE MIGRATION SCRIPT, per the team rule in
 * `feedback_migrations_standalone.md`. It is NOT invoked on server startup.
 * Anand runs this manually at cutover, validates the output, then proceeds
 * with deploying the code that references the resulting topic ID.
 *
 * Usage:
 *   HEDERA_ENV=testnet-uat node scripts/bootstrap-audit-topic.ts
 *
 * Pre-reqs: operator account + key loaded from `.env.<HEDERA_ENV>`. Script
 * does NOT take arguments — all config via env to match the server's model.
 *
 * State-check pattern (TODO(p4)):
 *   Before creating a new topic, query Hedera Mirror Node for topics whose
 *   `memo` field equals `xeni_audit_v1_<HEDERA_ENV>` and are owned by the
 *   operator account. If one exists → print it and exit 0 (idempotent
 *   re-run). If none → proceed with creation, setting the memo on the new
 *   topic so a future re-run finds it.
 *
 * Output contract: prints ONE line to stdout in the format:
 *   HEDERA_XENI_AUDIT_TOPIC_ID=0.0.xxxxxxx
 *   (ready to be appended to the env's .env file or copied into config)
 *
 * Anand validates:
 *   - Topic ID printed
 *   - Topic visible on HashScan for the target network
 *   - Topic memo matches `xeni_audit_v1_<HEDERA_ENV>`
 *   - Operator account balance decremented by ~$0.01 worth of HBAR
 */

// TODO(p4): import @hiero-ledger/sdk — TopicCreateTransaction, Client, TopicInfoQuery
// TODO(p4): import Mirror Node REST client (or use fetch) to query existing topics by memo
// TODO(p4): implement idempotent state-check preamble

async function main(): Promise<void> {
  // TODO(p4): const env = requireEnv('HEDERA_ENV');
  // TODO(p4): const memo = `xeni_audit_v1_${env}`;
  // TODO(p4): const existing = await findTopicByMemo(operatorAccountId, memo, network);
  // TODO(p4): if (existing) {
  // TODO(p4):   console.log(`HEDERA_XENI_AUDIT_TOPIC_ID=${existing.topicId}  # existing, unchanged`);
  // TODO(p4):   return;
  // TODO(p4): }
  //
  // TODO(p4): const client = Client.forNetwork(network).setOperator(operatorId, operatorKey);
  // TODO(p4): const tx = await new TopicCreateTransaction()
  // TODO(p4):   .setTopicMemo(memo)
  // TODO(p4):   .setAdminKey(operatorKey.publicKey)
  // TODO(p4):   .setSubmitKey(operatorKey.publicKey)  // submit-gated so only our operator can post
  // TODO(p4):   .execute(client);
  // TODO(p4): const receipt = await tx.getReceipt(client);
  // TODO(p4): console.log(`HEDERA_XENI_AUDIT_TOPIC_ID=${receipt.topicId!.toString()}  # newly created`);

  throw new Error(
    'bootstrap-audit-topic.ts is a scaffold skeleton. Implementation lands in the ' +
      'implementation PR. See TODO(p4) comments and docs/DESIGN.md §15 for the ' +
      'full state-check pattern.',
  );
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[ERROR] bootstrap-audit-topic failed:', err);
  process.exit(1);
});
