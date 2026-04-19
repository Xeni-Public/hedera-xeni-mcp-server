/**
 * M4 — Bootstrap dedicated treasury account + initial treasury→agent refund allowance.
 *
 * This is a STANDALONE MIGRATION SCRIPT. See `feedback_migrations_standalone.md`.
 * Anand runs this manually at cutover. Never invoked on server startup.
 *
 * Two-part setup:
 *   (a) Create a new Hedera account that will serve as `xeni_treasury` for the
 *       target env. Fund it from the operator's balance with a configurable
 *       initial amount (matches the configured daily refund cap + buffer).
 *   (b) Sign + submit the initial `AccountAllowanceApproveTransaction` granting
 *       the agent account permission to spend up to the daily cap from treasury.
 *
 * Usage:
 *   HEDERA_ENV=testnet-uat \
 *   HEDERA_REFUND_DAILY_CAP_HBAR=10000 \
 *   HEDERA_TREASURY_INITIAL_BALANCE_HBAR=30000 \
 *   node scripts/bootstrap-treasury.ts
 *
 * State-check pattern (TODO(p4)):
 *   Before creating a new account, search Mirror Node for accounts whose
 *   `memo` field equals `xeni_treasury_v1_<HEDERA_ENV>` and are reachable from
 *   the operator. If one exists → print it and check/refresh the agent
 *   allowance. If none → create new account with that memo.
 *
 * Output contract: prints env-ready lines to stdout:
 *   HEDERA_XENI_TREASURY_ID=0.0.xxxxxxx
 *   # Private key (cold — NEVER committed, NEVER put in server env)
 *   HEDERA_XENI_TREASURY_KEY_COLD=302e...
 *   # Initial refund allowance granted: 10000 HBAR, spender=<agent>
 *
 * Security:
 *   - Treasury private key is COLD. This script prints it once to stdout so
 *     Anand can transfer it to his laptop / HSM / hardware wallet. It is NOT
 *     written to any file, NOT committed to any .env file used by the server.
 *   - After bootstrap, the treasury key is used ONLY by Anand's
 *     offline signing tool for nightly allowance replenishment. See
 *     docs/RUNBOOKS.md "Treasury replenishment" section.
 *
 * Anand validates:
 *   - Account ID printed, visible on HashScan, memo matches `xeni_treasury_v1_<HEDERA_ENV>`
 *   - Treasury balance = initial amount
 *   - Approved allowance visible on Mirror Node: owner=treasury, spender=agent, amount=cap
 *   - Operator balance decremented by (initial treasury balance + ~$0.01 tx fees)
 */

// TODO(p4): import @hiero-ledger/sdk — AccountCreateTransaction, AccountAllowanceApproveTransaction,
// TODO(p4):   Client, Hbar, PrivateKey, AccountId, AccountInfoQuery
// TODO(p4): import Mirror Node REST client to find existing account by memo

async function main(): Promise<void> {
  // TODO(p4): const env = requireEnv('HEDERA_ENV');
  // TODO(p4): const memo = `xeni_treasury_v1_${env}`;
  // TODO(p4): const existing = await findAccountByMemo(operatorAccountId, memo, network);
  //
  // TODO(p4): if (existing) {
  // TODO(p4):   // Confirm allowance is current; reuse account
  // TODO(p4):   await ensureAllowance(existing.accountId, agentAccountId, dailyCap);
  // TODO(p4):   console.log(`HEDERA_XENI_TREASURY_ID=${existing.accountId.toString()}  # existing, allowance refreshed`);
  // TODO(p4):   return;
  // TODO(p4): }
  //
  // TODO(p4): // Create new treasury account
  // TODO(p4): const treasuryKey = PrivateKey.generateECDSA();
  // TODO(p4): const createTx = await new AccountCreateTransaction()
  // TODO(p4):   .setKey(treasuryKey.publicKey)
  // TODO(p4):   .setInitialBalance(new Hbar(initialBalance))
  // TODO(p4):   .setAccountMemo(memo)
  // TODO(p4):   .execute(operatorClient);
  // TODO(p4): const receipt = await createTx.getReceipt(operatorClient);
  // TODO(p4): const treasuryId = receipt.accountId!;
  //
  // TODO(p4): // Grant initial refund allowance: treasury → agent, up to daily cap
  // TODO(p4): const allowanceTx = await new AccountAllowanceApproveTransaction()
  // TODO(p4):   .approveHbarAllowance(treasuryId, agentAccountId, new Hbar(dailyCap))
  // TODO(p4):   .freezeWith(operatorClient)
  // TODO(p4):   .sign(treasuryKey)  // treasury signs the approval (this is the one time the key is used online; offline thereafter)
  // TODO(p4):   .then(tx => tx.execute(operatorClient));
  // TODO(p4): await allowanceTx.getReceipt(operatorClient);
  //
  // TODO(p4): console.log(`HEDERA_XENI_TREASURY_ID=${treasuryId.toString()}  # newly created`);
  // TODO(p4): console.log(`# COLD KEY — transfer to offline signing location; do not put in any server .env`);
  // TODO(p4): console.log(`HEDERA_XENI_TREASURY_KEY_COLD=${treasuryKey.toString()}`);
  // TODO(p4): console.log(`# Initial refund allowance granted: ${dailyCap} HBAR, spender=${agentAccountId}`);

  throw new Error(
    'bootstrap-treasury.ts is a scaffold skeleton. Implementation lands in the ' +
      'implementation PR. See TODO(p4) comments and docs/DESIGN.md §15 for the ' +
      'full state-check + allowance pattern.',
  );
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[ERROR] bootstrap-treasury failed:', err);
  process.exit(1);
});
