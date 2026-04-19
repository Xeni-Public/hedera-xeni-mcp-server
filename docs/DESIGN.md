# hedera-xeni-mcp-server — v1 Design

**Status:** v1, scaffold stage. Structure + docs landed; implementation lands in subsequent PRs.

## 1. Purpose

Thin plugin-based MCP server on upstream [`hedera-agent-kit-js`](https://github.com/hashgraph/hedera-agent-kit-js) v4. Minimum Hedera tool surface for autonomous travel bookings (HBAR payments + HCS audit). Xeni intent-mandate semantics layered via the kit's hook/policy system.

## 2. Upstream dependencies

| Package | Role | Version |
|---|---|---|
| `@hashgraph/hedera-agent-kit` | Plugin system, `BaseTool`, hooks, policies | Exact pin — see [DESIGN_DEPENDENCIES.md](DESIGN_DEPENDENCIES.md) |
| `@hashgraph/hedera-agent-kit-mcp` | `HederaMCPToolkit` (MCP server wrapper: stdio + StreamableHTTP) | Exact pin |
| `@hiero-ledger/sdk` | Low-level Hedera SDK (renamed from `@hashgraph/sdk` in v4) | Exact pin |

**Built-in tools we use without forking:** `create_topic` (one-time at deploy, via bootstrap script), `submit_message`, `approve_hbar_allowance`, `transfer_hbar_with_allowance`, `transfer_hbar`.

Mode switch (`AgentMode.AUTONOMOUS` vs `AgentMode.RETURN_BYTES`) is context-driven via `handleTransaction`. Dual-account model = two `Client` instances + resolver policy.

## 3. Account model (role-based registry; v1 minimum)

| Role | v1 | Future |
|---|---|---|
| `operator` | Xeni platform admin (pays HCS fees, topic ops). ECDSA key in env. | — |
| `agent` | Autonomous spender, bounded by allowances, signs approved transfers in both directions. ECDSA key in env. | — |
| `xeni_treasury` | Xeni-as-MoR receiving + refunding account. **Dedicated account, distinct from operator. Key kept cold** — used only for initial + replenishment refund-allowance approvals; never in server process env. Bootstrap via `scripts/bootstrap-treasury.ts` per env. <br><br>`TODO(p1):` document cold-key operational definition concretely: ops-laptop-signed (offline) / HSM / hardware wallet. POC is probably "ops-laptop-signed, never loaded into server env." Fill during implementation PR once ops procedure is ratified. | — |
| `xeni_platform_fee` | Off-chain bookkeeping | Optional on-chain split |
| `customer_accounts[*]` | Deferred | Phase 5: Customer-MoR |
| `supplier_accounts[*]` | Deferred | Phase 4: on-chain settlement |

**Per-env account isolation:** `operator`, `agent`, `xeni_treasury` each get distinct testnet accounts per environment (`dev`, `testnet-ci`, `testnet-uat`) + dedicated mainnet accounts for prod. No shared accounts across envs.

## 4. On-chain money flow (v1, Xeni-MoR only)

**Payment:** `User A → xeni_treasury` via `transfer_hbar_with_allowance`. Agent signs using User A's pre-granted allowance.

**Refund:** `xeni_treasury → User A` via `transfer_hbar_with_allowance`. Treasury pre-grants agent a bounded refund allowance (treasury key stays cold); agent signs individual refund txs. Blast radius = the allowance, not the treasury.

**Everything else off-chain in v1:** supplier payout, customer commission, platform fee split — mirrored in HCS audit events for transparency.

### Refund allowance strategy

| Decision | Value |
|---|---|
| **Sizing** | Rolling daily cap, **HBAR-denominated** (e.g. 10k HBAR/day; tune with volume data). Deterministic, no oracle dependency. |
| **Fiat context in alerts** | Slack alert message includes fiat-equivalent of remaining balance and daily cap, computed at alert time (Mirror Node exchange-rate query or CoinGecko). Cap itself stays HBAR. |
| **Refresh** | Manual nightly top-up — on-call ops signs new approval. |
| **Alert** | Slack webhook at 80% consumed (20% remaining). Channels per env: `#non-prod-oncall-fund-treasury` (dev/qa/uat), `#oncall-fund-treasury` (prod). Workspace: `xeniworkspace.slack.com`. |
| **Source of truth** | Query Hedera Mirror Node for remaining allowance — no local DB state. |
| **Runbook** | [RUNBOOKS.md](RUNBOOKS.md) covers: (a) nightly top-up, (b) cap-hit UX, (c) mid-day extension, (d) on-call escalation. Weekend/vacation coverage via on-call rotation implied by channel names. |
| **Timezone (cutover only)** | `America/Los_Angeles` (PST/PDT) — 00:00 Pacific is the daily cap-reset + replenishment window boundary. IANA name used in code to handle DST. **Scope: only the cutover boundary.** All persisted timestamps, HCS payload times, inter-service protocol fields, and log lines remain **UTC**. PST is resolved to UTC at the boundary by the scheduler; never stored. |
| **Phase 2** | Auto-top-up when threshold crossed. |

## 5. HCS topic model

**Single global `xeni_audit` topic per environment**, created once at deploy via `scripts/bootstrap-audit-topic.ts`, reused forever for that env. Every message carries `schema_version`, `event_id`, `intent_id`, `customer_id` (placeholder for Phase 5), `event` type, `tx_timestamp`, payload.

**Per-env topic IDs:** separate topic per environment to avoid mixing dev / CI / UAT / prod streams.

| Env | Topic ID env var | Created by |
|---|---|---|
| dev | `HEDERA_XENI_AUDIT_TOPIC_ID` in `.env.dev` | Bootstrap script, local testnet |
| testnet-ci | `HEDERA_XENI_AUDIT_TOPIC_ID` in CI secrets | Bootstrap script, testnet |
| testnet-uat | `HEDERA_XENI_AUDIT_TOPIC_ID` in UAT config | Bootstrap script, testnet |
| mainnet-prod | `HEDERA_XENI_AUDIT_TOPIC_ID` in prod secrets | Bootstrap script, mainnet |

Total topic-create cost: ~$0.04 for all four envs (one-time). Negligible.

**Rationale (vs per-intent topics):** HCS topics are public anyway — per-intent isolation buys zero privacy. Topic creation at ~$0.01 × N intents is real money at scale. Single ordered timeline per env is stronger audit than fragmented streams. Future split (per-customer in Phase 5, per-event-class if volume demands) is config-only.

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

## 6. Intent-mandate plugin (public) — tool/hook surface

| Component | Stage | Purpose | Side effects |
|---|---|---|---|
| `spendPolicyGuard` (hook) | `postParamsNormalizationHook` | Rejects `approve_hbar_allowance` if amount > user's policy ceiling | None (rejects or passes) |
| `mandateBudgetGuard` (hook) | `postParamsNormalizationHook` | Rejects `transfer_hbar_with_allowance` if exceeds remaining mandate | None |
| `treasuryAllowanceGuard` (hook) | `postParamsNormalizationHook` | Rejects refund if exceeds remaining treasury→agent daily cap; Slack alert at 80% | Slack webhook call (alert only, not audit) |
| `auditEnvelopeBuilder` (hook) | `postCoreActionHook` | Builds the audit event payload from tool result; **does NOT submit to HCS** | None — pure function; attached to response |
| `accountResolver` (policy) | — | Picks `operator` vs `agent` Client per tool | None |

**Zero net-new tools. Entire Xeni layer = 4 hooks + 1 policy.**

**Key invariant:** `auditEnvelopeBuilder` runs at `postCoreActionHook`, which `BaseTool` only invokes if `coreAction` succeeded. Audit envelopes never exist for failed transfers. HCS submission is driven by AgentService's outbox worker — not by this MCP.

## 7. Public / private boundary

**Repo visibility for v1:** Internal repo (`xeni-app/hedera-xeni-mcp-server`) ships the reference Xeni-MoR scaffolding under **Apache-2.0**. Public release to `Xeni-Public/hedera-xeni-mcp-server` is **deferred until v1 is proven working**. Apache-2.0 license is retained on the internal repo so the eventual public push is a simple remote add, not a license swap. The "public repo" terminology below describes the long-term distribution intent; today, both public and private plugins live in private-org repos.

Private fee-calculation logic is a separate plugin loaded at runtime via env (`HEDERA_XENI_PRIVATE_PLUGINS`).

```
hedera-xeni-mcp-server/              (PUBLIC)
├── src/plugins/xeniIntentMandate/   (PUBLIC — hooks + policy only, no tools)
├── src/fees/FeeCalculator.ts        (PUBLIC — interface)
├── src/fees/DefaultFeeCalculator.ts (PUBLIC — reference impl)

hedera-xeni-mcp-fee-private/         (PRIVATE, xeni-app only)
└── src/platformFeeCalculator.ts     (PRIVATE — real fee logic)
```

**Loader behavior — fail-open dev / fail-closed UAT+prod:**

| Env | `HEDERA_XENI_PRIVATE_PLUGINS` set? | Loader failure behavior |
|---|---|---|
| `NODE_ENV=development` | unset | Load `DefaultFeeCalculator`. Log `[INFO] Loaded fee calculator: DefaultFeeCalculator`. |
| `NODE_ENV=development` | set but load fails | **Fail-open.** Fall back to `DefaultFeeCalculator`. Log `[WARN] Private plugin load failed, falling back to DefaultFeeCalculator: <error>`. |
| `NODE_ENV=test` | — | Same as dev — fail-open. |
| `NODE_ENV=production` (UAT + prod) | unset | **Fail-closed.** Server refuses to start. Exit 1. Log `[ERROR] HEDERA_XENI_PRIVATE_PLUGINS required in production; refusing to start.` |
| `NODE_ENV=production` | set but load fails | **Fail-closed.** Server refuses to start. Exit 1. Log the error. |

**Startup health check:** after fee-calculator load, assert loaded impl name matches `EXPECTED_FEE_CALCULATOR_IMPL` env var (when set). Mismatch = refuse to start. Emit `[INFO] Loaded fee calculator: <impl-name>` on success so ops can grep logs and confirm.

## 8. Transports

Both `stdio` (AgentService spawns as child) and `StreamableHTTP` (debugging) supported. Matches upstream.

**Binding + security rules:**

| Env | Transport | Binding | Auth |
|---|---|---|---|
| dev | stdio OR http | http binds `127.0.0.1` only (loopback) via `HEDERA_HTTP_BIND` env. Default is loopback. | None — loopback only. |
| testnet-ci / testnet-uat | **stdio only** | N/A | AgentService spawns as child; no network boundary. |
| mainnet-prod | **stdio only** | N/A | Same. |

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
- Topic creates: ~$0.01 one-time (was ~$36,500/yr under per-intent model — saved)

**Rules:**
- HCS = audit only, never ops signaling (Slack handles alerts; HCS is ~$0.0002 each, Slack is free).
- Operator account pays HCS fees → needs its own balance monitoring + low-balance Slack alert.
- Keep payloads compact — every 100 bytes saved = ~$0.00011/event.
- Testnet for all dev + UAT.

## 11. Out of scope for v1 / deferred

- **Phase 2:** HTS / USDC / stablecoin allowances & transfers; auto-top-up of refund allowance; reconciliation worker for MCP-crash-between-transfer-and-response (known gap, §13); local DB mirror index for audit queries.
- **Phase 3:** HCS-listener-triggered booking flow.
- **Phase 4:** On-chain supplier settlement; on-chain customer commission payout.
- **Phase 5:** Customer-is-MoR flows (invoice + prepaid deposit); per-customer audit topics.
- NFT tooling.
- Scheduled transactions.
- LangChain / Vercel AI toolkit wiring.

## 12. Scenarios captured for future phases

| Scenario | MoR | Fee mechanism | v1? |
|---|---|---|---|
| 1. Xeni-MoR | `xeni_treasury` | Extracted from user payment (internal) | ✅ |
| 2. Customer-MoR, invoice | Customer treasury | Invoiced periodically | Phase 5 |
| 3. Customer-MoR, prepaid | Customer treasury | Drawn from prepaid deposit | Phase 5 |

## 13. Audit durability (outbox pattern)

**Problem.** Hedera transfers are irreversible. If a transfer succeeds on-chain but the HCS audit submit fails (network, congestion, operator balance), we have a silent audit gap. If HCS is submitted before the transfer is confirmed, we risk phantom audit events.

**Solution — outbox pattern.** MCP plugin never submits HCS; it only builds an envelope. AgentService persists the envelope to an outbox table; a worker drains the outbox by calling MCP's `submit_message` tool.

### Hook + data flow

```
┌───────────────────────────────────────────────────────────────────┐
│ AgentService                                                       │
│                                                                    │
│  1. Receive: "execute payment, intent=X, amount=$10"               │
│  2. MCP call (stdio) ──────────────────────────────┐               │
│                                                    │               │
│  8. Write outbox row:                              │               │
│     (intent_id, event, payload, status=pending) ◀──┤               │
│                                                    │               │
│  9. Return success to caller                       │               │
└─────────────────────────────────────────────┬──────┼───────────────┘
                                              │      │
                              stdio/JSON-RPC  │      │ response:
                                              ▼      │ { receipt,
┌─────────────────────────────────────────────────── │   auditEnvelope }
│ hedera-xeni-mcp-server                             │               │
│                                                    │               │
│  3. preNormalize hooks (run BEFORE tx construction):               │
│       spendPolicyGuard          (reject over ceiling)              │
│       mandateBudgetGuard        (reject over remaining)            │
│       treasuryAllowanceGuard    (refund path only)                 │
│                                                                    │
│  4. coreAction:                                                    │
│       HederaBuilder → TransferTransaction                          │
│       tx.execute(agentClient)                                      │
│       await getReceipt                                             │
│                                                                    │
│  5. postCore hook (runs ONLY if coreAction succeeded):             │
│       auditEnvelopeBuilder                                         │
│       → produces { event, event_id, intent_id, txId, ... }         │
│       → NO HCS submit here                                         │
│                                                                    │
│  6. Return: { receipt, auditEnvelope } ────────────┘               │
└────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────┐
│ AgentService outbox worker (async, bounded cadence)                │
│                                                                    │
│ 10. SELECT outbox WHERE status=pending LIMIT N                     │
│ 11. For each row: MCP call submit_message(audit_topic_id, payload) │
│ 12. On success:  UPDATE status=done, sequence=<topicSeq>           │
│     On failure:  retry_count++, exponential backoff                │
│     On retry > MAX: status=dead_letter  +  Slack alert             │
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
- Dead-letter alert: Slack webhook (same channel as treasury allowance alerts).

### Invariants

- No audit envelope exists for a failed transfer (enforced by `postCoreActionHook` only running on success).
- Every successful transfer produces exactly one outbox row (AgentService writes it in the same transaction that updates intent state).
- Every outbox row eventually reaches `done` or `dead_letter`.
- HCS is strictly eventually-consistent from the outbox's point of view; lag is observable via `outbox_depth` metric.
- **Double-submit invariant:** if the worker submits to HCS successfully but crashes before `UPDATE status=done`, retry will resubmit the same payload. HCS does not dedupe natively. **Consumers MUST dedupe by `event_id`** (UUID v4 from §5 schema). The consumer-side dedup test (prove that two submissions with the same `event_id` produce one consumer-visible record) belongs in **AgentService's outbox test suite** — not this repo, since this repo has no consumer. This repo's §14 Unit gate covers the **producer-side guarantee**: every `auditEnvelopeBuilder` call emits a unique `event_id`. (Already tested at `test/unit/auditEnvelopeBuilder.test.ts` → `generates a distinct event_id per call`.)

### Known gap (deferred to Phase 2)

*MCP crashes between `execute()` and returning the response to AgentService.* The transfer is on-chain but AgentService sees tool-call failure → no outbox row → audit gap by a different route. Mitigation: a reconciliation worker that queries Hedera Mirror Node for any intent in `payment_status=unknown` past a threshold, and backfills the outbox. Deferred because POC-stage probability is low and the fix is additive (no schema change).

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

| Layer | Scope | Tooling | CI gate |
|---|---|---|---|
| **Unit** | Each of the 4 hooks + 1 policy in isolation. Assert inputs → outputs, reject conditions, Slack payload shape. Includes **producer-side `event_id` uniqueness test** (MCP half of the P3 invariant; the consumer-side dedup test belongs in AgentService's outbox test suite — see §13). | `vitest` | **Required** on every PR |
| **Integration** | Plugin wired into a `HederaMCPToolkit` instance with `hedera-agent-kit` test doubles. Verify hook stages fire in the right order, `auditEnvelopeBuilder` runs only on success, `accountResolver` picks the right `Client`. | `vitest` + manual test doubles | **Required** on every PR |
| **E2E (testnet)** | Real testnet MCP server, real Hedera testnet, real operator/agent/treasury accounts (Anand-funded). Exercises (a) User→Agent allowance grant via RETURN_BYTES, (b) `transfer_hbar_with_allowance` payment, (c) refund via treasury→agent allowance, (d) audit envelope round-trip matches schema. | `vitest --project=e2e` + `@hiero-ledger/sdk` testnet client | **Nightly** on `testnet-ci` (not per-PR — testnet HBAR cost + latency) |
| **Smoke (post-deploy)** | Cutover-day sanity: one booking intent end-to-end on `testnet-uat` with AgentService integrated. Under §15 cutover step 7. | Manual checklist | Manual gate before mainnet promotion |

**Testnet account funding:** Anand owns funding operator/agent/treasury testnet accounts across `dev`, `testnet-ci`, `testnet-uat`. Runbook step: low-balance Slack alert to `#non-prod-oncall-fund-treasury`.

`TODO(p2):` testnet balance threshold — define a concrete number (e.g. "7 days of expected burn" in HBAR). Fill in [RUNBOOKS.md](RUNBOOKS.md) after first UAT gives a burn-rate data point.

**Not in v1 test scope:**
- Hedera SDK internals (upstream's tests cover).
- `hedera-agent-kit` internals (upstream's tests cover; we pin an exact version).
- Mainnet flows (smoke only; full E2E on testnet).
- Load / stress testing (Phase 2 when we know the volume profile).

**CI coverage targets:** ≥ 80% statements on our 4 hooks + 1 policy. Hooks are pure functions with narrow IO; high coverage should be cheap.

## 15. Migration & cutover

**Team rule (see internal memory `feedback_migrations_standalone.md`):** DB schema changes + data migrations + on-chain bootstrap are **standalone deployment steps, never run on server startup**. Anand owns running them; each buddy writes + tests the script and submits a Migration Action Item in the project coordination log.

**Implications for this repo:**
- `package.json` has **no `prestart` migration hook**. MCP server boots cleanly assuming all bootstrap state already exists.
- On-chain bootstrap scripts live in `scripts/` (not `src/`) and are invoked manually by Anand per env.
- If required env vars are missing at startup, the server fails loudly — never auto-creates.

**Migration action items for cutover:**

| ID | Owner | Title | Script |
|---|---|---|---|
| M1 | AIAgent Service Buddy | Drop `hcs_topic_id` column from `intent` table | AgentService PR |
| M2 | AIAgent Service Buddy | Create `hedera_audit_outbox` table (schema in §13) | AgentService PR |
| M3 | Hedera Buddy | Create global `xeni_audit` HCS topic (one per env) | `scripts/bootstrap-audit-topic.ts` |
| M4 | Hedera Buddy | Bootstrap dedicated treasury account + treasury→agent refund allowance | `scripts/bootstrap-treasury.ts` |

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

## 16. Canonical MCP response shape

Tool calls from this MCP return:

```json
{
  "receipt": {
    "status": "SUCCESS",
    "txId": "0.0.agent@1745612345.123456789",
    "consensus_timestamp": "2026-04-18T22:15:03.123456789Z",
    "network": "testnet",
    "topic_sequence_number": null,
    "topic_running_hash": null
  },
  "auditEnvelope": {
    "schema_version": 1,
    "event_id": "4f9c8a12-...",
    "event": "payment_executed",
    "tx_timestamp": "2026-04-18T22:15:03Z",
    "intent_id": "...",
    "customer_id": "...",
    "user": "0.0.userA",
    "total": 10.0,
    "destination": "xeni_treasury",
    "split_accounting": { "supplier_cost": 8.0, "platform_fee": 1.0, "customer_commission": 1.0 },
    "booking_ref": "...",
    "txId": "0.0.agent@1745612345.123456789",
    "remaining_user_allowance": 90.0
  }
}
```

- `receipt.topic_sequence_number` / `topic_running_hash` populated **only** for `submit_message` responses; omitted for transfer responses.
- `receipt.txId` and `auditEnvelope.txId` are the same value by design — receipt is the raw Hedera artifact, envelope is the durable audit record. Redundant so either stands alone.
- `event_id` generated by `auditEnvelopeBuilder` in this MCP (not by AgentService). AgentService stores the ID unchanged for consumer-side dedup.
- Nulls omitted, not sent as `null`.

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
