<!-- Authored-by: Anand Palanisamy - anand@xeni.com -->

# hedera-xeni-mcp-server — v1 Design

## 1. Purpose

Thin MCP server on upstream [`hedera-agent-kit-js`](https://github.com/hashgraph/hedera-agent-kit-js) v4. Exposes upstream HBAR payment + HCS audit tools as-is via `HederaMCPToolkit`. No Xeni custom tools, no plugin-level hooks, no dual-client logic — AgentService (Go) owns the business logic that sits in front of and behind these calls.

## 2. Upstream dependencies

| Package                           | Role                                                            | Version                                                          |
| --------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------- |
| `@hashgraph/hedera-agent-kit`     | Plugin system, `BaseTool`, hooks, policies                      | Exact pin — see [DESIGN_DEPENDENCIES.md](DESIGN_DEPENDENCIES.md) |
| `@hashgraph/hedera-agent-kit-mcp` | `HederaMCPToolkit` (MCP server wrapper: stdio + StreamableHTTP) | Exact pin                                                        |
| `@hiero-ledger/sdk`               | Low-level Hedera SDK (renamed from `@hashgraph/sdk` in v4)      | Exact pin                                                        |

**Built-in tools we use without forking:** `create_topic` (one-time at deploy, via bootstrap script), `submit_message`, `approve_hbar_allowance`, `transfer_hbar_with_allowance`, `transfer_hbar`.

Mode switch (`AgentMode.AUTONOMOUS` vs `AgentMode.RETURN_BYTES`) is context-driven via `handleTransaction`. Dual-account model = two `Client` instances + resolver policy.

## 3. Account model (role-based registry; v1 minimum)

| Role                   | v1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Future                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| `operator`             | Xeni platform admin. **Key kept cold** post-pivot — used only for bootstrap scripts (M3 topic create, M4 treasury create) and ops emergencies. **NOT loaded in the running server's env.** Since upstream's `HederaMCPToolkit` takes one client (agent), operator never signs at runtime.                                                                                                                                                                                                                                      | —                            |
| `agent`                | Sole runtime signing identity in the MCP server. Signs every tool-driven transaction: approve allowance bytes (user-signed in RETURN_BYTES mode, not signed by agent), transfers via allowance, and HCS audit submits (agent pays the HCS fee now that operator is cold). ECDSA key in server env.                                                                                                                                                                                                                             | —                            |
| `xeni_treasury`        | Xeni-as-MoR receiving + refunding account. **Dedicated account, distinct from operator. Private KEY kept cold** — used only for initial + replenishment refund-allowance approvals; never in server process env. The ACCOUNT ID (`HEDERA_XENI_TREASURY_ID`) IS loaded at runtime — it's a public identifier, used by read-only Mirror Node queries (e.g. `get_treasury_allowance_remaining` — see §6 post-pivot section). Bootstrap via `scripts/bootstrap-treasury.ts` per env. <br><br>`TODO(p1):` document cold-key operational definition concretely: ops-laptop-signed (offline) / HSM / hardware wallet. POC is probably "ops-laptop-signed, never loaded into server env." Fill during implementation PR once ops procedure is ratified. | —                            |
| `xeni_platform_fee`    | Off-chain bookkeeping                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Optional on-chain split      |
| `customer_accounts[*]` | Deferred                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Phase 5: Customer-MoR        |
| `supplier_accounts[*]` | Deferred                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Phase 4: on-chain settlement |

**Per-env account isolation:** `operator`, `agent`, `xeni_treasury` each get distinct testnet accounts per environment (`dev`, `testnet-ci`, `testnet-uat`) + dedicated mainnet accounts for prod. No shared accounts across envs.

**ID vs KEY distinction (cold-key invariant, precise definition):** the "cold key" rule protects **private keys**, not public account IDs. Account IDs like `0.0.12345` are already on-chain data and appear in HashScan, Mirror Node responses, and every transaction receipt — treating them as secret is theater. Concretely:

- **Private KEYs** (`HEDERA_OPERATOR_KEY`, `HEDERA_XENI_TREASURY_KEY`) must stay out of the running server's env. The server WARN-logs on startup if it sees them (see `src/accounts.ts::warnIfColdKeyLeaked`).
- **Account IDs** (`HEDERA_OPERATOR_ID`, `HEDERA_XENI_TREASURY_ID`) are safe in runtime env. `HEDERA_XENI_TREASURY_ID` is loaded at runtime specifically so `get_treasury_allowance_remaining` can name the (treasury → agent) pair to Mirror Node.

`HEDERA_OPERATOR_ID` is NOT loaded at runtime today, but could be in the future without breaking the invariant — the rule is about keys, not IDs.

### External URLs — required env, fail-fast (no hardcoded defaults)

Two external-service URLs are required at startup in every environment — dev, testnet-ci, testnet-uat, and mainnet-prod:

| Env var                     | Purpose                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `HEDERA_MIRROR_NODE_URL`    | Mirror Node REST API root. Threaded into every fetch call in `src/plugins/xeniRead/` and `scripts/lib/`.      |
| `HEDERA_HASHSCAN_BASE_URL`  | HashScan explorer root. Used for runbook log hints (e.g. the M4 re-use-path treasury link) and future UI.     |

**Fail-fast rule:** if either var is missing, empty, or whitespace-only, `src/server.ts::loadConfig()` and `scripts/lib/bootstrapEnv.ts::loadBootstrapEnv()` both throw with a clear message naming the missing variable. The server + every bootstrap script refuses to start.

**No hardcoded defaults anywhere in the code.** A sensible-looking default (e.g. "fall back to the testnet mirror") would mask the exact failure mode this rule exists to prevent: a mainnet-key deploy accidentally running against the testnet mirror, or vice versa. Every environment — including dev — must set these vars explicitly, so the operator thinks about which env they're in at configuration time rather than discovering it from a failed production transaction.

**`.env.example` A.5** documents the canonical public values (`https://testnet.mirrornode.hedera.com`, `https://mainnet-public.mirrornode.hedera.com`, `https://hashscan.io`) as copy-paste suggestions. Private / internal mirrors or vanity explorers can be substituted without code change.

**CI**: the `e2e-nightly` workflow env block (both the smoke-check step and the E2E test step) sets these explicitly — same posture as local dev.

## 4. On-chain money flow (v1, Xeni-MoR only)

**Payment:** `User A → xeni_treasury` via `transfer_hbar_with_allowance`. Agent signs using User A's pre-granted allowance.

**Refund:** `xeni_treasury → User A` via `transfer_hbar_with_allowance`. Treasury pre-grants agent a bounded refund allowance (treasury key stays cold); agent signs individual refund txs. Blast radius = the allowance, not the treasury.

**Everything else off-chain in v1:** supplier payout, customer commission, platform fee split — mirrored in HCS audit events for transparency.

### Refund allowance strategy

| Decision                    | Value                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sizing**                  | Rolling daily cap, **HBAR-denominated** (e.g. 10k HBAR/day; tune with volume data). Deterministic, no oracle dependency.                                                                                                                                                                                                                                             |
| **Fiat context in alerts**  | Alert payload includes fiat-equivalent of remaining balance and daily cap, **computed at alert time** via upstream `get_exchange_rate_tool` (Mirror Node, HBAR→USD only; CoinGecko planned for multi-currency in Phase 2). Cap itself stays HBAR. Rate is never cached across alerts — fresh query per emit. See [XENI_LAYER.md §6 "Currency conversion"](XENI_LAYER.md#6-currency-conversion-hbar--fiat) for the full dynamic-conversion convention.                                                                                                         |
| **Refresh**                 | Manual nightly top-up — on-call ops signs new approval.                                                                                                                                                                                                                                                                                                              |
| **Alert**                   | Ops alert webhook at 80% consumed (20% remaining). Transport + destination (channel / workspace / recipient mapping) is AgentService-owned configuration — this MCP repo does not name a specific channel or workspace. Operators wire the alert to whatever they use (Slack, PagerDuty, email, etc.). |
| **Source of truth**         | Query Hedera Mirror Node for remaining allowance — no local DB state.                                                                                                                                                                                                                                                                                                |
| **Runbook**                 | [RUNBOOKS.md](RUNBOOKS.md) covers: (a) nightly top-up, (b) cap-hit UX, (c) mid-day extension, (d) on-call escalation. Weekend/vacation coverage via on-call rotation implied by channel names.                                                                                                                                                                       |
| **Timezone (cutover only)** | `America/Los_Angeles` (PST/PDT) — 00:00 Pacific is the daily cap-reset + replenishment window boundary. IANA name used in code to handle DST. **Scope: only the cutover boundary.** All persisted timestamps, HCS payload times, inter-service protocol fields, and log lines remain **UTC**. PST is resolved to UTC at the boundary by the scheduler; never stored. |
| **Phase 2**                 | Auto-top-up when threshold crossed.                                                                                                                                                                                                                                                                                                                                  |

## 5. HCS topic model

**Single global `xeni_audit` topic per environment**, created once at deploy via `scripts/bootstrap-audit-topic.ts`, reused forever for that env. Every message carries `schema_version`, `event_id`, `intent_id`, `customer_id` (placeholder for Phase 5), `event` type, `tx_timestamp`, payload.

**Per-env topic IDs:** separate topic per environment to avoid mixing dev / CI / UAT / prod streams.

| Env          | Topic ID env var                             | Created by                      |
| ------------ | -------------------------------------------- | ------------------------------- |
| dev          | `HEDERA_XENI_AUDIT_TOPIC_ID` in `.env.dev`   | Bootstrap script, local testnet |
| testnet-ci   | `HEDERA_XENI_AUDIT_TOPIC_ID` in CI secrets   | Bootstrap script, testnet       |
| testnet-uat  | `HEDERA_XENI_AUDIT_TOPIC_ID` in UAT config   | Bootstrap script, testnet       |
| mainnet-prod | `HEDERA_XENI_AUDIT_TOPIC_ID` in prod secrets | Bootstrap script, mainnet       |

Total topic-create cost: ~$0.04 for all four envs (one-time). Negligible.

**Rationale (vs per-intent topics):** HCS topics are public anyway — per-intent isolation buys zero privacy. Topic creation at ~$0.01 × N intents is real money at scale. Single ordered timeline per env is stronger audit than fragmented streams. Future split (per-customer in Phase 5, per-event-class if volume demands) is config-only.

### Topic key design (created by M3 `bootstrap-audit-topic.ts`)

Each `xeni_audit` topic is created with explicit admin + submit keys. The choice keeps runtime signing aligned with the cold-key invariant and leaves key-rotation paths intact.

| Key field    | Value                    | Why                                                                                                                                                                                                                                                                                                                             |
| ------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memo`       | `xeni_audit_v1_<env>`    | **Validity check** on re-run (not a lookup key). When M3 re-runs with `HEDERA_XENI_AUDIT_TOPIC_ID` already set in env, it fetches the topic's memo via Mirror Node `/api/v1/topics/{id}` and asserts it equals the expected value — guards against ops pasting a wrong topic ID into an env file. `_v1_` segment reserves room for a future `_v2_` schema alongside the old topic. Env label NOT normalized (case-preserving) so `testnet-UAT` ≠ `testnet-uat`. **Idempotency mechanism**: env-var presence, mirrors M4's `HEDERA_XENI_TREASURY_ID` pattern. (See issue #18 for why the previous "walk operator's topics by memo" approach didn't work — that Mirror Node endpoint doesn't exist.)            |
| `admin_key`  | `operator.publicKey`     | Lets the operator later rotate `submit_key` (e.g. agent key rotation) or update metadata without recreating the topic + losing the audit timeline. Operator is cold, loaded only by ops at bootstrap + rotation time.                                                                                                           |
| `submit_key` | `agent.publicKey`        | Only the agent can post to the topic at runtime. Prevents unauthorized actors from polluting our audit stream. The agent public key is fetched from Mirror Node at bootstrap time — the script never holds the agent private key. (If `submit_key` were the operator's key instead, runtime submits would fail — operator is cold.) |

**Agent key rotation path:** operator signs a `TopicUpdateTransaction` with the new agent's public key as the new `submit_key`. No new topic; audit timeline continues uninterrupted. Documented in `RUNBOOKS.md` (TODO — rotation runbook lands alongside first rotation).

**Why not no submit_key (public-write topic):** would let any on-chain actor post to our audit stream. Readers (AgentService ingestion, Frontend HashScan verification) would need to filter by payer, which is brittle — an attacker can still pollute the stream even if our consumers filter, and the topic history is permanent. The ~$0.04 one-time cost of setting submit_key is trivial compared to the forever-polluted-audit-stream risk.

### HCS audit event schema (v1)

```json
{
  "schema_version": 1,
  "event_id": "4f9c8a12-1234-4abc-b5de-6fa7bcd89e01",
  "event": "payment_executed",
  "tx_timestamp": "2026-04-18T22:15:03Z",
  "intent_id": "...",
  "customer_id": "...",
  "user": "0.0.userA",
  "total": 10.0,
  "destination": "xeni_treasury",
  "split_accounting": {
    "supplier_cost": 8.0,
    "platform_fee": 1.0,
    "customer_commission": 1.0
  },
  "booking_ref": "...",
  "txId": "0.0.agent@1745612345.123456789",
  "remaining_user_allowance": 90.0
}
```

**Fields:**

- `schema_version: 1` — readers detect v1 vs future v2 and adapt without breaking.
- `event_id` — server-generated UUID v4 for consumer-side deduplication. HCS gives sequence per topic, but `event_id` is globally unique and survives DB-mirror replay.
- `tx_timestamp` — consensus timestamp from the receipt, UTC ISO 8601.
- `remaining_user_allowance` — payment events only. Omitted when not applicable.
- `treasury_allowance_remaining_after` — refund events only. Omitted when not applicable.

**Null-omission rule:** fields that do not apply are **omitted from the JSON entirely**, not sent as `null`. Smaller payloads (~$0.00011 savings per 100 bytes) and cleaner JSON.

Day-1 schema holds placeholders for future on-chain splits (`supplier_cost`, `customer_commission`) so no audit-ledger migration when supplier/commission payouts move on-chain later.

## 6. Intent-mandate plugin — REMOVED post-pivot

**Post-pivot state:** this MCP has **no Xeni plugin, no hooks, no custom policy**. Upstream tools are exposed as-is through `HederaMCPToolkit`.

All four hooks + one policy previously planned here (`spendPolicyGuard`, `mandateBudgetGuard`, `treasuryAllowanceGuard`, `auditEnvelopeBuilder`, `accountResolver`) are **relocated to AgentService** per the pivot callout at the top of this doc. Go-port specs and contracts are in [HANDOVER_TO_AGENT_SERVICE.md](HANDOVER_TO_AGENT_SERVICE.md). TS reference implementations live in `reference-impl/` with their vitest suites intact as behavioral specs.

### Pre-pivot surface (historical, for reference)

Pre-pivot MCP-side layer — **relocated, not cancelled.** `spendPolicyGuard` and `mandateBudgetGuard` were actually merged in PRs #4 and #5 with full implementations + test suites; `treasuryAllowanceGuard` + `auditEnvelopeBuilder` landed in PRs #6 / the scaffold. The pivot moves the same behaviors to AgentService (Go) rather than starting from zero. TS implementations stay as executable specs under `reference-impl/` (PR #9).

| Component                                                  | Where now                                                       |
| ---------------------------------------------------------- | --------------------------------------------------------------- |
| `spendPolicyGuard`                                         | AgentService, pre-`approve_hbar_allowance` call                 |
| `mandateBudgetGuard`                                       | AgentService, pre-`transfer_hbar_with_allowance` (payment path) |
| `treasuryAllowanceGuard` + ops alert + Mirror Node query | AgentService, pre-`transfer_hbar_with_allowance` (refund path)  |
| `auditEnvelopeBuilder`                                     | AgentService, post-MCP-response before outbox write             |
| `accountResolver`                                          | Not needed — single runtime client (agent)                      |

**Zero Xeni business logic in the MCP plugin system.** The "Xeni intent-mandate plugin" concept is gone from this repo. What remains inside `src/` is the MCP scaffolding: `server.ts` (toolkit construction), `transports/` (stdio + http), `accounts.ts` (single-account validation), `logger.ts`.

### Narrow exception: `xeniReadPlugin` (read-only wrappers)

One small Xeni-owned plugin exists, and by design it carries **no business logic** — only thin wrappers around public on-chain / Mirror Node state that AgentService would otherwise have to query directly (violating Option D's "MCP is the single gateway to Hedera" principle).

| Tool                               | PR     | Purpose                                                                                                                                                                              |
| ---------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `get_treasury_allowance_remaining` | PR #13 | Returns `{ remainingHbar: number }` for the (treasury → agent) pair. Consumer: AgentService's `treasuryAllowanceGuard`. Pure read via Mirror Node REST `allowances/crypto` endpoint. |

**What belongs here, what doesn't:**

- ✅ Thin REST/on-chain reads with no decisions (balance queries, allowance queries, topic-message fetches, receipt lookups)
- ❌ Any policy check, budget enforcement, rejection reason, or value-judgment. Those all stay AgentService-side.
- ❌ Any write path. All writes already go through upstream core tools (`transfer_hbar`, `submit_topic_message`, etc.).

Future read tools will naturally accrete here (e.g. `get_audit_topic_latest_sequence` for Frontend's HashScan verification, `get_agent_balance` for treasury alerting). The plugin is a container, not a precedent for business-logic creep.

## 7. Public / private boundary

**Repo visibility for v1:** Internal repo (`xeni-app/hedera-xeni-mcp-server`) under **Apache-2.0**. Public release to `Xeni-Public/hedera-xeni-mcp-server` is **deferred until v1 is proven working**. Apache-2.0 license is retained on the internal repo so the eventual public push is a remote add, not a license swap.

**Post-pivot:** this MCP has **no proprietary business logic**. There is nothing to hide — the server is a thin wrapper over upstream `hedera-agent-kit-js` + Xeni-specific env conventions + bootstrap scripts. The public/private split that previously existed inside this MCP (for the fee calculator plugin) has **moved to AgentService**.

### What moved

| Pre-pivot (MCP)                                                              | Post-pivot (AgentService)                                                                       |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `src/fees/FeeCalculator.ts` (interface)                                      | `reference-impl/fees/FeeCalculator.ts` (TS spec) → Go port in AgentService                      |
| `src/fees/DefaultFeeCalculator.ts` (10% flat, public reference)              | `reference-impl/fees/DefaultFeeCalculator.ts` (TS spec) → Go port in AgentService for tests/dev |
| `hedera-xeni-mcp-fee-private` repo plan (dynamic plugin loading)             | AgentService-private Go module with the real fee logic                                          |
| `HEDERA_XENI_PRIVATE_PLUGINS` env, `EXPECTED_FEE_CALCULATOR_IMPL` assertions | AgentService-side equivalents (Go `FeeCalculator` interface + startup assertion)                |

**Nothing private lives in this MCP.** A future open-source push of this repo can happen cleanly — no fee-logic secrets to redact, no dynamic-load plumbing to document. `.env.example`, `README.md`, and bootstrap scripts are the most Xeni-specific files; those describe the public integration surface.

See [HANDOVER_TO_AGENT_SERVICE.md §6](HANDOVER_TO_AGENT_SERVICE.md) for the fee-calculator Go port specs.

## 8. Transports

Both `stdio` (AgentService spawns as child) and `StreamableHTTP` (debugging) supported. Matches upstream.

**Binding + security rules:**

| Env                      | Transport      | Binding                                                                                 | Auth                                               |
| ------------------------ | -------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------- |
| dev                      | stdio OR http  | http binds `127.0.0.1` only (loopback) via `HEDERA_HTTP_BIND` env. Default is loopback. | None — loopback only.                              |
| testnet-ci / testnet-uat | **stdio only** | N/A                                                                                     | AgentService spawns as child; no network boundary. |
| mainnet-prod             | **stdio only** | N/A                                                                                     | Same.                                              |

**Hard rule:** in UAT and prod, the MCP server must NEVER be reachable from outside the AgentService container. No HTTP port bound. HTTP in non-dev requires a token-gated auth layer (not in v1 scope).

**Why this matters:** the MCP server exposes HBAR transfer tools. An unauthenticated HTTP endpoint is a direct money drain.

Startup assertion: if `NODE_ENV=production` and `HEDERA_TRANSPORT=http`, the server refuses to start.

## 9. Orchestration

```
ai-agent-web (Claude + MCP directly — no LangChain)
    ↓
AgentService (ai-agent-api-service, Go; built on Falcon framework)
  │  │  │
  │  │  └──► hedera-xeni-mcp-server  (money tools)
  │  └─────► xeni-mcp-server          (booking tools)
  │
  └──► audit outbox table (postgres) ──► outbox worker ──► hedera-xeni-mcp-server.submit_message ──► global xeni_audit topic
```

AgentService owns the intent state machine. Money tool calls are synchronous (`pay → book`). Audit submissions are **async via outbox** — see §13.

## 10. Cost model

Per-message HCS fee ~$0.0002 (300-byte payload). At 10k bookings/day × ~5 events/booking:

- Message submits: ~$3,650/yr
- Topic creates: ~$0.01 one-time per env (was ~$36,500/yr under the abandoned per-intent model — saved)

**Rules:**

- HCS = audit only, never ops signaling (the alert webhook handles ops; HCS is ~$0.0002 each, the webhook transport is essentially free).
- **Agent account pays HCS fees** post-pivot. Previously operator was going to pay, but the single-client constraint (§3) makes agent the only runtime signer, so agent covers every `submit_message` call driven by AgentService's outbox worker.
- Agent therefore needs its own balance monitoring + low-balance ops alert (routed to the same on-call destination as treasury alerts; AgentService-owned config).
- Keep payloads compact — every 100 bytes saved = ~$0.00011/event. (Payload-shape choice now lives in AgentService's Go `audit.BuildEnvelope` — not this MCP.)
- Testnet for all dev + UAT.

**Operator** (cold, bootstrap-only) pays only the one-time topic-create fees (~$0.01 per env) when Anand runs `scripts/bootstrap-audit-topic.ts`. No ongoing cost.

**Treasury** (cold) pays only the periodic allowance-approve transaction fees (~$0.0001 each, nightly) when ops tops up the agent's refund allowance.

## 11. Out of scope for v1 / deferred

- **Phase 2:** HTS / USDC / stablecoin allowances & transfers — **design locked in [USDC_DESIGN.md](USDC_DESIGN.md)** (2026-04-28); auto-top-up of refund allowance; reconciliation worker for MCP-crash-between-transfer-and-response (known gap, §13); local DB mirror index for audit queries.
- **Phase 3:** HCS-listener-triggered booking flow.
- **Phase 4:** On-chain supplier settlement; on-chain customer commission payout.
- **Phase 5:** Customer-is-MoR flows (invoice + prepaid deposit); per-customer audit topics.
- NFT tooling.
- Scheduled transactions.
- LangChain / Vercel AI toolkit wiring.

## 12. Scenarios captured for future phases

| Scenario                 | MoR               | Fee mechanism                          | v1?     |
| ------------------------ | ----------------- | -------------------------------------- | ------- |
| 1. Xeni-MoR              | `xeni_treasury`   | Extracted from user payment (internal) | ✅      |
| 2. Customer-MoR, invoice | Customer treasury | Invoiced periodically                  | Phase 5 |
| 3. Customer-MoR, prepaid | Customer treasury | Drawn from prepaid deposit             | Phase 5 |

## 13. Audit durability (outbox pattern)

**Problem.** Hedera transfers are irreversible. If a transfer succeeds on-chain but the HCS audit submit fails (network, congestion, low balance), we have a silent audit gap. If HCS is submitted before the transfer is confirmed, we risk phantom audit events.

**Solution — outbox pattern, entirely AgentService-side.** MCP just executes upstream tools and returns receipts. AgentService does all guard checks before calling, builds the envelope locally after the receipt comes back, persists to the outbox in the same DB transaction as the intent state update, and drains the outbox asynchronously via MCP's plain `submit_message` tool.

### Data flow (post-pivot)

```
┌────────────────────────────────────────────────────────────────────┐
│ AgentService (Go)                                                   │
│                                                                     │
│  1. Receive: "execute payment, intent=X, amount=$10"                │
│                                                                     │
│  2. Pre-call guards (fail-fast; no MCP round-trip on reject):       │
│       spendPolicyGuard      (allowance ≤ user policy ceiling)       │
│       mandateBudgetGuard    (amount ≤ mandate remaining)            │
│       treasuryAllowanceGuard (refund only — Mirror Node + alert)    │
│                                                                     │
│  3. MCP call (stdio) ──────────────────────────────┐                │
│                                                    │                │
│  7. Receive raw Hedera receipt                     │                │
│                                                    │                │
│  8. AgentService.audit.BuildEnvelope(receipt, intent, fees):        │
│       { schema_version, event_id (UUID v4), tx_timestamp,           │
│         intent_id, customer_id, user, total, destination,           │
│         split_accounting, booking_ref, txId, ... }                  │
│                                                                     │
│  9. DB transaction:                                                 │
│       UPDATE intent SET state = ...                                 │
│       INSERT INTO hedera_audit_outbox (payload_json, status=pending)│
│                                                                     │
│ 10. Return success to caller                                        │
└─────────────────────────────────────────────┬──────────┼────────────┘
                                              │          │
                              stdio/JSON-RPC  │          │ response:
                                              ▼          │ receipt only
┌─────────────────────────────────────────────────────── │            ┐
│ hedera-xeni-mcp-server                                 │            │
│   (thin — no Xeni hooks, no plugin)                    │            │
│                                                        │            │
│  4. upstream tool execute(agentClient, context, params):            │
│       HederaBuilder → TransferTransaction                           │
│       tx.execute(agentClient)                                       │
│       await getReceipt                                              │
│                                                                     │
│  5. upstream handler returns: string text of receipt                │
│                                                                     │
│  6. MCP transport serializes + returns ─────────────┘               │
└────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────┐
│ AgentService outbox worker (async, bounded cadence)                │
│                                                                    │
│ 10. SELECT outbox WHERE status=pending LIMIT N                     │
│ 11. For each row: MCP call submit_message(audit_topic_id, payload) │
│ 12. On success:  UPDATE status=done, sequence=<topicSeq>           │
│     On failure:  retry_count++, exponential backoff                │
│     On retry > MAX: status=dead_letter  +  ops alert               │
│                                                                    │
│ Metrics: outbox_depth, dead_letter_count → dashboard               │
└────────────────────────────────────────────────────────────────────┘
```

### Outbox schema sketch (AgentService DB)

```sql
hedera_audit_outbox (
  id              bigserial primary key,
  intent_id       text not null,
  event_type      text not null,       -- payment_executed, refund_executed, allowance_granted, ...
  payload_json    jsonb not null,      -- the auditEnvelope from MCP response
  status          text not null,       -- pending | done | dead_letter
  retry_count     int  not null default 0,
  last_attempt_at timestamptz,
  created_at      timestamptz not null default now(),
  hcs_tx_id       text,                -- populated on success
  hcs_sequence    bigint               -- populated on success; used for deep-links
)
```

### Retry policy (defaults; tune in UAT)

- Cadence: worker tick every 5s.
- Batch: 50 pending rows per tick.
- Backoff: exponential, base 2s, cap 5min.
- Max retries: 10 (dead-letter after ~85 min of attempts).
- Dead-letter alert: ops webhook (same destination as treasury allowance alerts; AgentService-owned config).

### Invariants

- No audit envelope exists for a failed transfer — AgentService builds the envelope **only after receiving a SUCCESS receipt from the MCP**. On MCP error or rejected guards, no envelope, no outbox row.
- Every successful transfer produces exactly one outbox row (AgentService writes intent state update + outbox insert in the same DB transaction).
- Every outbox row eventually reaches `done` or `dead_letter`.
- HCS is strictly eventually-consistent from the outbox's point of view; lag is observable via `outbox_depth` metric.
- **Double-submit invariant:** if the worker submits to HCS successfully but crashes before `UPDATE status=done`, retry will resubmit the same payload. HCS does not dedupe natively. **Consumers MUST dedupe by `event_id`** (UUID v4 from §5 schema). Both producer-side uniqueness and consumer-side dedup tests now live in AgentService's test suite (post-pivot). TS reference implementation in `reference-impl/hooks/auditEnvelopeBuilder.ts` + tests serves as a behavioral spec for AgentService's Go port — the TS tests still run in this repo's CI as executable specifications.

### Known gap (deferred to Phase 2)

_MCP crashes between `execute()` and returning the response to AgentService._ The transfer is on-chain but AgentService sees tool-call failure → no outbox row → audit gap by a different route. Mitigation: a reconciliation worker that queries Hedera Mirror Node for any intent in `payment_status=unknown` past a threshold, and backfills the outbox. Deferred because POC-stage probability is low and the fix is additive (no schema change).

### Mirror Node scale

At 10k bookings/day × ~5 events each = 50k events/day ≈ 18M events/year on the global `xeni_audit` topic. Consumer-side filtering by `intent_id` is client-side over Mirror Node's REST API. POC-sufficient. If fast customer-facing audit queries become a product requirement, a local DB index (indexed by `intent_id`, `customer_id`) lands in Phase 2.

### HashScan deep-link verification

The URL pattern `https://hashscan.io/<net>/topic/{topic_id}?sequence={n}` is our preferred deep-link. Lead Buddy (frontend scope) **owns verification** that HashScan supports this query parameter. If unsupported, fallback hierarchy (user-facing before dev-facing):

1. **User-facing:** link to the global `xeni_audit` topic on HashScan (`/topic/{audit_topic_id}`, no sequence param). User identifies their own events by searching `intent_id` in the topic view. Degraded UX but functional for end users.
2. **Dev-facing:** Mirror Node REST JSON API — what engineers use during debugging.
3. **Phase 2+:** own audit-viewer UI (explicit scope creep for v1; not in scope until product requirement justifies it).

Frontend verification outcome drives which branch actually ships.

### Cost impact

Unchanged. HCS submits still cost ~$0.0002 each; the outbox adds DB storage (trivial) and one worker goroutine (trivial). No extra Hedera ops.

## 14. Testing strategy

**Post-pivot:** the MCP test surface is much smaller. Runtime-executed code in this repo is just server wiring + transports + bootstrap scripts + `accounts.ts` + `logger.ts`. The 68 tests from PR #4/#5/#6 move to `reference-impl/tests/` and **continue to run in this repo's CI as executable specifications** for the AgentService Go port — they validate the TS reference implementations against their documented contracts. AgentService's own test suite (Go) owns the production-path guard tests.

| Layer                    | Scope                                                                                                                                                                                                                                                                                                                                                                            | Tooling                                                     | CI gate                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------- |
| **MCP runtime unit**     | `accounts.ts` env validation + fail-loud on missing vars; `logger.ts` level gating + UTC formatting; `server.ts` fail-open/closed loader (if retained) + HTTP-in-prod refusal; transport loopback-only assertion.                                                                                                                                                                | `vitest`                                                    | **Required** on every PR                                               |
| **MCP integration**      | `HederaMCPToolkit` instantiated with a test operator account; exposed tool list matches expectation; stdio transport accepts a MCP init handshake. Mock the `Client` or use a short-lived testnet stub.                                                                                                                                                                          | `vitest`                                                    | **Required** on every PR                                               |
| **Reference-impl specs** | TS implementations of `spendPolicyGuard`, `mandateBudgetGuard`, `treasuryAllowanceGuard`, `auditEnvelopeBuilder`, `hbar.ts`, `fees/*` in `reference-impl/` with their PR #4–#6 vitest suites. Validates the behavioral contract for AgentService's Go port — not executed by the MCP at runtime.                                                                                 | `vitest`                                                    | **Required** on every PR (guards the contract)                         |
| **E2E (testnet)**        | Real testnet MCP server, real Hedera testnet, real agent account (Anand-funded). Exercises: (a) User→Agent allowance grant flow (MCP builds unsigned bytes in RETURN_BYTES mode), (b) `transfer_hbar_with_allowance` payment, (c) refund via treasury→agent allowance, (d) `submit_message` round-trip. Envelope-building is AgentService's responsibility — not exercised here. | `vitest --project=e2e` + `@hiero-ledger/sdk` testnet client | **Nightly** on `testnet-ci` (not per-PR — testnet HBAR cost + latency) |
| **Smoke (post-deploy)**  | Cutover-day sanity: one booking intent end-to-end on `testnet-uat` with AgentService integrated. Under §15 cutover step 7.                                                                                                                                                                                                                                                       | Manual checklist                                            | Manual gate before mainnet promotion                                   |

**Testnet account funding:** Anand owns funding the agent testnet account across `dev`, `testnet-ci`, `testnet-uat`. (Operator + treasury are cold — funded once at bootstrap; don't burn ongoing testnet HBAR.) Runbook: low-balance ops alert to the configured non-prod destination.

`TODO(p2):` testnet balance threshold — define a concrete number (e.g. "7 days of expected burn" in HBAR). Fill in [RUNBOOKS.md](RUNBOOKS.md) after first UAT gives a burn-rate data point.

**Not in v1 test scope:**

- Hedera SDK internals (upstream's tests cover).
- `hedera-agent-kit` internals (upstream's tests cover; we pin an exact version).
- AgentService-side guard/envelope tests (live in AgentService's Go suite, covered by its own CI — see [HANDOVER_TO_AGENT_SERVICE.md](HANDOVER_TO_AGENT_SERVICE.md) for port targets).
- Mainnet flows (smoke only; full E2E on testnet).
- Load / stress testing (Phase 2 when we know the volume profile).

**CI coverage targets:**

- **Runtime code (`src/`):** ≥80% statements once wiring lands (PR #10 onwards). Narrow surface.
- **Reference-impl (`reference-impl/`):** 100% maintained — these are behavioral specs, any uncovered code is a spec-gap risk. Fail the gate on regression.

## 15. Migration & cutover

**Team rule (see internal memory `feedback_migrations_standalone.md`):** DB schema changes + data migrations + on-chain bootstrap are **standalone deployment steps, never run on server startup**. Anand owns running them; each buddy writes + tests the script and submits a Migration Action Item in the project coordination log.

**Implications for this repo:**

- `package.json` has **no `prestart` migration hook**. MCP server boots cleanly assuming all bootstrap state already exists.
- On-chain bootstrap scripts live in `scripts/` (not `src/`) and are invoked manually by Anand per env.
- If required env vars are missing at startup, the server fails loudly — never auto-creates.

**Migration action items for cutover:**

| ID  | Owner                 | Title                                                                  | Script                             |
| --- | --------------------- | ---------------------------------------------------------------------- | ---------------------------------- |
| M1  | AIAgent Service Buddy | Drop `hcs_topic_id` column from `intent` table                         | AgentService PR                    |
| M2  | AIAgent Service Buddy | Create `hedera_audit_outbox` table (schema in §13)                     | AgentService PR                    |
| M3  | Hedera Buddy          | Create global `xeni_audit` HCS topic (one per env)                     | `scripts/bootstrap-audit-topic.ts` |
| M4  | Hedera Buddy          | Bootstrap dedicated treasury account + treasury→agent refund allowance | `scripts/bootstrap-treasury.ts`    |

**Each script must:**

- Be idempotent (re-runnable mid-failure), or include a clear state-check preamble so Anand can tell what's already applied.
- Log every row/state-affecting operation.
- Fit on one screen of instructions: "run this file, expect this output, verify this count / topic ID / account ID."

`TODO(p4):` state-check pattern — use `memo` field on topics/accounts set to `"xeni_audit_v1_<env>"` / `"xeni_treasury_v1_<env>"`. Re-running checks for the memo and skips creation if found. Implement in bootstrap scripts + document in [RUNBOOKS.md](RUNBOOKS.md).

### Cutover sequence

1. **Scripts ready** — all four scripts written + tested on a throwaway env by their owners.
2. **Migration action items submitted** — coordination log rows move `pending-script` → `ready`.
3. **Anand runs M3 + M4** — creates testnet audit topic + treasury account + refund allowance. Captures topic ID + treasury account ID.
4. **Env files populated** — `HEDERA_XENI_AUDIT_TOPIC_ID`, `HEDERA_XENI_TREASURY_ID` filled in AgentService config + MCP server `.env`.
5. **Anand runs M1 + M2** on AgentService DB (testnet first, then prod). Validates: column dropped, new table exists + empty.
6. **Three PRs merge same day** — Hedera MCP binary deploy, AgentService (schema + outbox worker + MCP spawn command + HashScan URL pattern), Frontend (drop `hcs_topic_id` from UI model + new URL pattern). Coordinated merge window.
7. **Smoke test on testnet-uat** — one booking intent end-to-end. `TODO(p5):` explicit pass/fail checklist in [RUNBOOKS.md](RUNBOOKS.md) — payment tx confirmed ✓, outbox row written ✓, HCS event visible on HashScan ✓, UI shows deep-link ✓.
8. **Promote to mainnet-prod** — rerun M3 + M4 on mainnet, then M1 + M2 on prod DB, then same-day PR merges.

### Rollback

- **Code:** revert `mcp.hedera_server_command` in AgentService config to point at the old binary; redeploy.
- **Schema:** M1 (column drop) is not auto-reversible. POC acceptable (no real user data). For mainnet keep a read-only snapshot of `intent` pre-M1 as safety net.
- **On-chain:** not applicable. Hedera topics/accounts are append-only; new ones cost pennies to recreate.

### UAT intents on old server

**None.** Old `xeni-hedera-mcp-server` was a test — no live intents to drain. Cutover is a clean cut.

## 16. Canonical MCP response shape (post-pivot — just receipt)

Tool calls from this MCP return the raw Hedera receipt only. AgentService builds the audit envelope itself (post-pivot — the `auditEnvelope` field that used to be bundled here is gone).

```json
{
  "status": "SUCCESS",
  "txId": "0.0.agent@1745612345.123456789",
  "consensus_timestamp": "2026-04-18T22:15:03.123456789Z",
  "network": "testnet",
  "topic_sequence_number": null,
  "topic_running_hash": null
}
```

Notes:

- `topic_sequence_number` / `topic_running_hash` populated **only** on `submit_message` responses; omitted (not `null`) on transfer responses.
- `consensus_timestamp` is the authoritative source of truth for audit timing. AgentService passes this to its Go `audit.BuildEnvelope(...)` as the `tx_timestamp` input.
- Null optional fields are omitted per the null-omission rule, not sent as literal `null`.

**Retired contract:** the previous `{ receipt, auditEnvelope }` envelope-bundled shape is gone. AgentService constructs envelopes locally from this receipt + its intent state; see [HANDOVER_TO_AGENT_SERVICE.md](HANDOVER_TO_AGENT_SERVICE.md) for the Go port spec.

### ⚠ Upstream gap on `submit_message` — `topicSequenceNumber` not exposed

The idealized shape above shows `topic_sequence_number` on the response. **In practice upstream `@hashgraph/hedera-agent-kit@4.0.0` maps `receipt.topicSequenceNumber` → nothing** in its `RawTransactionResponse`. The default `postProcess` for the topic-submit tool returns only a text message with `transactionId`.

**v1 workaround (AgentService-side):** after a successful `submit_message` call, AgentService queries Hedera Mirror Node for the transaction (`GET /api/v1/transactions/{transactionId}`) to retrieve `sequence_number` + `running_hash`. One extra Mirror Node call per submit at the outbox-drain-worker layer — async path, acceptable latency. Reuses the Mirror Node client AgentService already builds for `treasuryAllowanceGuard`.

**Long-term (Phase 2+):** contribute an upstream PR to add `topicSequenceNumber` + `topicRunningHash` to `RawTransactionResponse`. Small, obvious win. Tracked.

Full rationale + Go implementation hint in [HANDOVER_TO_AGENT_SERVICE.md → MCP response shape](HANDOVER_TO_AGENT_SERVICE.md).

**Status:** v1, scaffold + 3 guard hooks landed; **architectural pivot 2026-04-20** relocates guards to AgentService. See the pivot note below, then [HANDOVER_TO_AGENT_SERVICE.md](HANDOVER_TO_AGENT_SERVICE.md) for Go-port specs.

> ### ⚑ 2026-04-20 — Architectural pivot to Option D (guards in AgentService)
>
> Originally this MCP hosted the Xeni guard layer (4 hooks + 1 policy) on top of upstream tools. Verifying `@hashgraph/hedera-agent-kit-mcp@1.0.0` surfaced two upstream constraints that made that design impractical:
>
> 1. **Single-client model** — `HederaMCPToolkit({ client, configuration })` takes one signing identity for the whole server. Dual-identity (operator + agent) inside one MCP would require running two toolkit instances, forking the MCP package, or fragile mid-transaction client swaps.
> 2. **No per-call metadata passthrough** — upstream drops MCP `_meta` (in `_extra`) before calling tools; hooks can't see per-call `intentId` / policy / mandate state without extending every tool's zod params (custom wrapper tools) or forking upstream.
>
> **Decision:** MCP stays thin (upstream toolkit + transports + agent client + bootstrap scripts). All Xeni business logic (spend policy, mandate budget, treasury allowance + ops alerting + Mirror Node query, audit envelope builder, fee calculator) moves to AgentService (Go). TS reference implementations from PR #4/#5/#6 go to `reference-impl/` as executable specs.
>
> **Sections affected by this pivot:** §3 (operator now cold), §6 (plugin surface empty), §7 (fee plugin moves), §10 (agent pays HCS fees, not operator), §13 (audit flow simpler), §14 (test strategy), §16 (response shape drops `auditEnvelope`). Each section below is updated; pre-pivot content is kept where still accurate.
>
> **What stays:** outbox pattern §13, per-env topic model §5, refund allowance strategy §4 (now implemented Go-side), global timezone rule, migration convention §15.

## Scaffold checklist (tracked — what this PR delivers)

- [x] `package.json` with exact pinned versions (see [DESIGN_DEPENDENCIES.md](DESIGN_DEPENDENCIES.md))
- [x] `tsconfig.json`, `.eslintrc.cjs`, `.prettierrc`, `vitest.config.ts`
- [x] `.gitignore` excluding `.env*`, `dist`, `node_modules`, secrets
- [x] `.env.example` with all required + optional env vars
- [x] `README.md` with naming note
- [x] `LICENSE` Apache-2.0
- [x] `docs/DESIGN.md` (this file)
- [x] `docs/DESIGN_DEPENDENCIES.md`
- [x] `docs/RUNBOOKS.md` skeleton (P1, P2, P5 TODOs)
- [x] `scripts/bootstrap-audit-topic.ts` skeleton (M3, P4 memo-check pattern)
- [x] `scripts/bootstrap-treasury.ts` skeleton (M4, P4 memo-check pattern)
- [x] `src/` skeleton — server, transports, plugin, hooks, policy, fees, accounts, logger
- [x] `.github/workflows/ci.yml` with unit + integration gates

**Not in this scaffold** (lands in implementation PRs):

- Actual hook logic.
- Actual bootstrap-script execution logic (skeleton + state-check pattern only).
- E2E test project setup.
- Concrete numbers for P1 (cold-key), P2 (balance threshold), P5 (smoke commands).
