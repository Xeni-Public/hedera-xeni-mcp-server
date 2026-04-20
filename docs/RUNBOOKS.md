<!-- Authored-by: Anand Palanisamy - anand@xeni.com -->

# Runbooks — `hedera-xeni-mcp-server`

Operational procedures for ops + on-call engineers. Each section is a self-contained playbook.

**Alert channels:**

- `#non-prod-oncall-fund-treasury` (dev / qa / uat)
- `#oncall-fund-treasury` (prod)
- Workspace: `xeniworkspace.slack.com`

## Treasury replenishment (nightly manual top-up)

### When this runs

Daily at 00:00 `America/Los_Angeles` — on-call ops signs a fresh `AccountAllowanceApproveTransaction` that grants the agent the daily refund budget for the next 24h. Triggered by schedule, or manually mid-day if the 80% alert fires.

### Key location

Treasury key is **cold** (not in the server process env).

`TODO(p1):` document cold-key operational definition concretely. Candidate options:

- Ops laptop-signed (offline) — the default POC expectation. Key lives on an ops engineer's laptop; connects to Hedera only to sign this transaction. Never deployed to any server env.
- Hardware wallet (Ledger + Hedera app) — Phase 2 if we want stronger separation.
- HSM — Phase 3 when compliance requires it.

Implementation PR fills this in with the concrete mechanism Xeni adopts.

### Procedure (placeholder — fill in implementation PR)

1. On-call engineer opens laptop, navigates to `/path/to/treasury-signing-tool` (TBD).
2. Confirms daily cap from [DESIGN.md §4 Refund allowance strategy](DESIGN.md) or env override.
3. Signs `AccountAllowanceApproveTransaction(owner=xeni_treasury, spender=agent, amount=<cap>)`.
4. Submits to Hedera mainnet (or testnet per env).
5. Validates transaction succeeded on HashScan.
6. Posts confirmation in the env's on-call channel with txId + new allowance value.

### Cap-hit UX (mid-day cap exhaustion)

If the daily cap exhausts before midnight:

1. Active refund attempts fail with `treasuryAllowanceGuard` rejection.
2. Claude (via AgentService) informs the user: "Refund is processing — it will complete within 24 hours."
3. On-call engineer is paged via `#oncall-fund-treasury` at the 80% threshold alert (giving 20% buffer to act).
4. On-call engineer evaluates: mid-day extension, or wait for nightly reset.
5. If extension: engineer signs a top-up approval (steps 2–6 above, with smaller amount sufficient for rest of day).

### On-call escalation

- Tier 1: whoever's on rotation in `#non-prod-oncall-fund-treasury` (non-prod) or `#oncall-fund-treasury` (prod).
- Tier 2: Hedera Buddy (for technical questions about the allowance mechanism).
- Tier 3: Anand (for policy decisions — e.g., "should we double the daily cap?").

### Allowance repair (post-M4 partial failure)

**Scenario:** `npm run bootstrap:treasury` logged:

```
[bootstrap-treasury] ERROR: allowance grant failed AFTER treasury 0.0.xxxxx was created...
```

The treasury account exists on-chain (balance funded) but has NO allowance granted to the agent. Re-running the bootstrap script will NOT retry — it detects the treasury via `HEDERA_XENI_TREASURY_ID` and takes the idempotent path.

**Why it can happen:** tx-fee fluctuation, Mirror Node hiccup during receipt polling, network congestion between the account-create and allowance-approve transactions. The two txs aren't atomic — they're sequential.

**Recovery procedure (placeholder — fill in when first occurrence happens):**

1. Confirm state: query Mirror Node / HashScan to verify (a) the treasury account exists with the configured balance, and (b) no crypto allowance exists for `owner=treasury, spender=agent`.
2. Retrieve the cold treasury key from wherever ops stashed it after M4 (laptop vault / HSM / hardware wallet).
3. Sign a one-off `AccountAllowanceApproveTransaction(owner=treasury, spender=agent, amount=<intended-initial-allowance>)` — either via a dedicated small script, the Hiero CLI, or a manually-composed tx. (TODO: add a `scripts/repair-treasury-allowance.ts` helper in a follow-up PR once we see real-world frequency.)
4. Verify the allowance appeared on Mirror Node before putting the cold key back into offline storage.

**Why this isn't auto-retry in the bootstrap script:** retry-with-backoff on-chain is subtle — we'd need to detect "receipt timeout" vs "real failure" and avoid double-charging if the first tx actually succeeded. Manual repair is the safer first implementation; a helper script can come later when we have data on how often this fires.

## Testnet balance monitoring

Operator, agent, and treasury testnet accounts need funding.

`TODO(p2):` define concrete balance threshold — e.g. "alert when balance drops below 7 days of expected burn" or "alert below X HBAR." Fill in here after first UAT smoke test gives a burn-rate data point (Anand funds; Anand observes first week; threshold locks in).

### Alert → action

1. Low-balance Slack alert fires in `#non-prod-oncall-fund-treasury`.
2. Anand (current owner of testnet funding) tops up the account using testnet faucet or personal testnet HBAR reserves.
3. Ack in channel with txId + new balance.

## Outbox dead-letter response (AgentService-side)

> Note: this runbook is mirrored from AgentService's repo for Hedera-side context. Authoritative copy lives in AgentService's repo.

If an outbox row reaches `status=dead_letter`:

1. Dead-letter alert fires in the env's channel with: `intent_id`, `event_type`, `event_id`, retry count, last error.
2. On-call triages: is it a permanent schema issue (rebuild payload + resubmit) or transient Hedera / network issue (manual requeue)?
3. If transient: `UPDATE hedera_audit_outbox SET status='pending', retry_count=0 WHERE id=<id>;` and let the worker pick it up.
4. If permanent: root-cause first. Don't retry until cause understood.

## Cutover smoke test

Runs after migration action items M1–M4 complete and all three PRs (Hedera, AgentService, Frontend) deploy.

`TODO(p5):` expand this section with exact commands and expected outputs. Skeleton:

### Prereqs

- Operator / agent / treasury accounts funded on `testnet-uat`.
- `HEDERA_XENI_AUDIT_TOPIC_ID` populated in all three services from M3 output.
- Treasury→agent refund allowance live (from M4 output).

### Test flow (one booking intent end-to-end)

1. **User allowance grant.** User A signs an `approve_hbar_allowance` in their wallet (HashPack / WalletConnect) granting agent account X HBAR.
   - **Expected:** allowance tx confirmed on testnet. HashScan shows the grant.
2. **Payment.** AgentService calls MCP `transfer_hbar_with_allowance(owner=userA, spender=agent, to=xeni_treasury, amount=N)`.
   - **Expected:** payment tx confirmed ✓. MCP response contains `{ receipt, auditEnvelope }`. AgentService writes outbox row.
3. **Outbox → HCS.** AgentService outbox worker drains and submits.
   - **Expected:** outbox row moves to `status=done` with `hcs_tx_id` + `hcs_sequence` populated ✓.
4. **HashScan deep-link.** Frontend renders the link using `hcs_sequence`.
   - **Expected:** clicking link opens the correct HCS event on HashScan ✓.
5. **Refund path.** (Optional for initial smoke) — cancel the booking, verify refund uses treasury→agent allowance.
   - **Expected:** refund tx confirmed; `treasury_allowance_remaining_after` in audit envelope ≤ pre-refund value.

### Sign-off

Each ✓ confirmed by the cutover engineer in writing in the coordination log before mainnet promotion.

## Operator balance monitoring

Separate from treasury top-up. The `operator` account pays HCS fees (topic ops + message submits). Balance depletes ~$0.0002 per event × volume.

### Alert → action

- Low-balance Slack alert below some threshold (TBD).
- Anand tops up operator from platform HBAR reserves.

`TODO(p2):` fix the threshold here alongside the testnet-balance one. Same data source.
