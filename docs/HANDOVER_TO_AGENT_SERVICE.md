<!-- Authored-by: Anand Palanisamy - anand@xeni.com -->

# Handover to AgentService

**Status:** Architectural pivot. Guard logic that was originally planned inside `hedera-xeni-mcp-server` (as MCP plugin hooks) is handed over to `ai-agent-api-service` (AgentService) for Go-side implementation.

**Why the pivot:** verified upstream `@hashgraph/hedera-agent-kit-mcp@1.0.0` has two constraints that make MCP-side hooks impractical:

1. **Single-client model.** `HederaMCPToolkit({ client, configuration })` takes one `Client` — the entire server runs under one signing identity. Our design had operator paying HCS fees and agent signing transfers as separate identities. Forcing dual identity would require running two toolkit instances, forking the MCP package, or fragile mid-transaction client swaps. None acceptable for v1.
2. **No per-call metadata passthrough.** The MCP SDK supports `_meta` in request params, but `@hashgraph/hedera-agent-kit-mcp`'s registered handler at `dist/esm/index.mjs` explicitly drops `_extra` (which contains `_meta`) before calling `_hederaAgentKit.run(method, arg)`. Tools and hooks never see `_meta`. AgentService can't thread per-call intent metadata (`intentId`, `policyCeilingHbar`, `mandateTotalHbar`, etc.) into hooks without either (a) extending each tool's zod params (custom wrapper tools — adds tools we didn't want) or (b) forking upstream (external dependency).

Given both constraints, moving guards to AgentService is the cleanest path. AgentService already owns intent state and calls the MCP synchronously — doing policy + budget + treasury-allowance checks _before_ the MCP call is fail-fast and uses data AgentService already has in hand.

## What changes for AgentService

AgentService now owns (Go-side port of TS reference code):

| Concern                                                    | Reference implementation                                      | Lives in                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------ |
| Spend-policy ceiling check                                 | `reference-impl/hooks/spendPolicyGuard.ts` + tests            | pre-`approve_hbar_allowance` call                                  |
| Mandate budget check                                       | `reference-impl/hooks/mandateBudgetGuard.ts` + tests          | pre-`transfer_hbar_with_allowance` (payment path)                  |
| Treasury allowance check + Slack alert + Mirror Node query | `reference-impl/hooks/treasuryAllowanceGuard.ts` + tests      | pre-`transfer_hbar_with_allowance` (refund path)                   |
| HCS audit envelope building                                | `reference-impl/hooks/auditEnvelopeBuilder.ts` + tests        | post-MCP-response, before outbox write                             |
| Tinybar math + number validation                           | `reference-impl/hbar.ts` + tests                              | shared utility for all guards                                      |
| Platform fee calculation                                   | `reference-impl/fees/{FeeCalculator,DefaultFeeCalculator}.ts` | interface + reference impl for audit envelope's `split_accounting` |

All files land in `reference-impl/` in the MCP repo (PR #9) as executable TypeScript specs. They are **not built** into the MCP binary but **are tested** in MCP's CI — the tests serve as behavioral specs for the Go port. If you change Go behavior, the TS tests still describe the contract the Go port must match.

## What stays in the MCP

`hedera-xeni-mcp-server` stays focused on what the MCP is well-suited for:

| Stays                                                          | Why                                                    |
| -------------------------------------------------------------- | ------------------------------------------------------ |
| `HederaMCPToolkit` wiring (single client = agent)              | Expose upstream HBAR/HCS tools as-is                   |
| stdio + http transports                                        | Standard MCP transport machinery                       |
| `src/accounts.ts` (single-account registry: agent + env label) | Parse + validate agent account from env at startup     |
| `src/logger.ts`                                                | Team log conventions (stderr, UTC, no emojis)          |
| Bootstrap scripts (M3 audit topic, M4 treasury)                | On-chain state specific to Xeni; Anand runs at cutover |
| Xeni env var conventions (`HEDERA_XENI_AUDIT_TOPIC_ID`, etc.)  | Documented contract for AgentService + ops             |

## What AgentService needs to implement

### 1. Spend-policy ceiling guard (pre-`approve_hbar_allowance`)

**Reference:** `reference-impl/hooks/spendPolicyGuard.ts`, `reference-impl/tests/spendPolicyGuard.test.ts`.

**Contract (port to Go):**

- Inputs: `amountHbar` (requested allowance), `policyCeilingHbar` (user's configured ceiling), `intentId`, optional `correlationId`.
- Decision: reject if `amountHbar > policyCeilingHbar` (tinybar-integer comparison to avoid FP rounding).
- Inclusive boundary: `amount === ceiling` passes.
- Fail-closed validation: NaN / ±Infinity / negative amount or ceiling, or empty `intentId` → reject with reason naming the bad field.
- Reject reason format: `Requested allowance (N HBAR) exceeds user's configured spend ceiling (M HBAR).` — AgentService surfaces this to the user unchanged.
- Side effects: log (warn on reject, debug on pass).
- Call site: AgentService calls guard before any MCP request to `approve_hbar_allowance`. On reject, don't call MCP.

**Test coverage target:** ports of all 19 TS test cases. Pay attention to the tinybar-precision tests — they lock the FP-safety invariant.

### 2. Mandate-budget guard (pre-payment-`transfer_hbar_with_allowance`)

**Reference:** `reference-impl/hooks/mandateBudgetGuard.ts`, `reference-impl/tests/mandateBudgetGuard.test.ts`.

**Contract:**

- Inputs: `amountHbar`, `mandateTotalHbar`, `mandateSpentHbar`, `intentId`, optional `correlationId`.
- Decision: reject if `amountTb > (totalTb - spentTb)` (tinybar).
- Data-integrity check: if `spentTb > totalTb`, the mandate state itself is corrupt — reject with a specific reason surfacing the upstream bug (shouldn't happen; if it does, investigate).
- Inclusive boundary at `amount === remaining`.
- Fail-closed validation on all three numeric fields.
- `remainingHbar` returned on pass and on amount-exceeds reject (useful for surfacing to user); 0 on invalid-input or invalid-mandate-state rejects.
- Call site: AgentService computes `remaining` from its intent state before calling MCP for payment transfers.

**Test coverage target:** ports of all 20 TS test cases.

### 3. Treasury-allowance guard (pre-refund-`transfer_hbar_with_allowance`) — with Slack alert + Mirror Node query

**Reference:** `reference-impl/hooks/treasuryAllowanceGuard.ts`, `reference-impl/tests/treasuryAllowanceGuard.test.ts`.

**Contract:**

- Inputs: `amountHbar`, `intentId`, optional `correlationId`, optional `fiatPerHbar`.
- Dependencies injected: `queryRemainingAllowanceHbar()`, `sendSlackAlert(payload)`, `dailyCapHbar`, `thresholdFraction`, `envLabel`.
- Decision flow:
  1. Input validation (fail-closed).
  2. Query Hedera Mirror Node for the current treasury→agent remaining allowance. Fail-closed on network error or invalid response.
  3. Reject if `amountHbar > currentRemaining` with reason `Refund (X HBAR) exceeds remaining treasury→agent allowance (Y HBAR). Treasury needs top-up — see docs/RUNBOOKS.md#treasury-replenishment.`
  4. Threshold-crossing alert: fire `sendSlackAlert` fire-and-forget when this refund causes `remaining` to drop from `>= dailyCap * (1 - thresholdFraction)` to `< dailyCap * (1 - thresholdFraction)`. Only on the crossing refund, not every refund below threshold.
  5. Pass.
- Slack alert payload (lock the shape — ops subscribers depend on it):
  ```
  {
    envLabel: string,             // 'dev' / 'testnet-ci' / 'testnet-uat' / 'mainnet-prod'
    remainingHbar: number,        // after this refund
    dailyCapHbar: number,
    fiatEquivalent: number | null,
    fiatPerHbar: number | null,
    timestampUtc: string,         // ISO 8601 — source of truth
    timestampPst: string,         // human-readable for ops
    runbookRef: string            // 'docs/RUNBOOKS.md#treasury-replenishment'
  }
  ```
- Slack send is **fire-and-forget**: hook does NOT await Slack; Slack failures do NOT flip the pass/reject decision (just log).

**Test coverage target:** ports of all 24 TS test cases — pay attention to the "fire-and-forget" tests (they lock the "Slack failure doesn't block transfer" invariant) and the threshold-crossing tests (they lock the no-spam rule).

### 4. Audit envelope builder (post-MCP-response, pre-outbox-write)

**Reference:** `reference-impl/hooks/auditEnvelopeBuilder.ts`, `reference-impl/tests/auditEnvelopeBuilder.test.ts`.

**Contract (pure function):**

- Inputs: `event`, `txId`, `txTimestamp`, `intentId`, `customerId`, `user`, `total`, `destination`, `splitAccounting`, `bookingRef`, optional `remainingUserAllowance` (payment events only), optional `treasuryAllowanceRemainingAfter` (refund events only).
- Output: the canonical audit envelope per design doc §5.
- `event_id`: **server-generated UUID v4** inside the builder. **AgentService is the generator post-pivot.** Consumer-side dedup keys off this.
- Null-omission rule: optional fields (remainingUserAllowance, treasuryAllowanceRemainingAfter) omitted from JSON when not applicable — not `null`.
- `schema_version: 1` always.
- Output JSON is what AgentService writes to the `hedera_audit_outbox.payload_json` column and what the outbox worker submits to HCS via MCP's `submit_message` tool.

**Test coverage target:** ports of all 10 TS test cases. The UUID-v4 regex test is worth porting to catch a bad UUID library choice.

### 5. Tinybar math + number validation

**Reference:** `reference-impl/hbar.ts`, `reference-impl/tests/hbar.test.ts`.

Small utility (~40 LoC). Key functions:

- `toTinybar(hbar number) → bigint`: `BigInt(Math.round(hbar * 1e8))` — recovers the integer after FP multiplication.
- `fromTinybar(bigint) → number`: `Number(tb) / 1e8`. Precision-bounded at ~90M HBAR (`Number(bigint)` loses precision above `2^53`).
- `invalidNumberReason(value, name) → string | null`: fail-closed check on NaN / Infinity / negative.

Ports cleanly to Go (`int64` for tinybar). The TS precision bound doesn't apply in Go (int64 is exact up to 2^63), but the **shape of the validation** (fail-closed on NaN/negative) must stay the same so guards reject identical inputs across languages.

### 6. Platform fee calculation (audit envelope `split_accounting`)

**Reference:** `reference-impl/fees/FeeCalculator.ts` (interface), `reference-impl/fees/DefaultFeeCalculator.ts` (flat 10% reference).

The **real** fee calculation is proprietary and is expected to live in a private AgentService module (not `hedera-xeni-mcp-fee-private` — that was MCP-side plugin machinery we no longer need). Port the `FeeCalculator` interface to a Go type + private impl. The reference impl (flat 10%) is only for tests / local-dev.

The calculator is used inside the audit envelope builder to populate `split_accounting` (supplier_cost / platform_fee / customer_commission).

## MCP response shape (what AgentService receives)

**Simpler than previously planned** — since AgentService builds the envelope itself, the MCP response only carries the Hedera receipt:

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

- `topic_sequence_number` / `topic_running_hash` populated only on `submit_message` responses; omitted on transfer responses.
- AgentService takes this receipt, combines with intent state, calls its ported `auditEnvelopeBuilder` to produce the full envelope, writes to outbox.

**Previous `{ receipt, auditEnvelope }` contract is retired.** MCP doesn't build envelopes anymore. Any code in AgentService that parses `auditEnvelope` from an MCP response should be changed to call `BuildAuditEnvelope` locally instead.

## Timing + sequencing

1. **Hedera side (H-MCP-Buddy):** PR #8 (this doc + design-doc updates, no code moves) → PR #9 (move files to `reference-impl/`) → PR #10 (thin server + stdio) → PR #11 (http) → PR #12 (M3 impl) → PR #13 (M4 impl) → PR #14 (E2E testnet-ci) → signal "MCP ready on testnet".
2. **AgentService side (you):** port the 6 concerns above to Go once `reference-impl/` lands. Your port can proceed in parallel with later Hedera PRs — you don't need to wait for the MCP signal to start the Go ports.
3. **Coordinated cutover:** as before — 3-way merge (Hedera MCP + AgentService + Frontend).

## Scope change for your existing outbox PR B

The outbox PR B you were planning (M1 + M2 + outbox table + worker) expands slightly:

**New work added:**

- Pre-MCP guards (spendPolicyGuard, mandateBudgetGuard, treasuryAllowanceGuard)
- Mirror Node client for treasury allowance query (inject into treasuryAllowanceGuard)
- Slack webhook sender (same for treasuryAllowanceGuard alerts + outbox dead-letter alerts — may be able to share the sender)
- Audit envelope builder (called between MCP response and outbox write)
- FeeCalculator + default + private impl

**No longer needed:**

- Defensive parsing for two `sequenceNumber` key variants — MCP only returns one receipt shape now.
- `auditEnvelope` parsing from MCP response — MCP doesn't return one.

**Updated PR B shape:**

- Drop: parsing for `auditEnvelope` in MCP response.
- Add: three guards in `services/intentService/` or similar, invoked before MCP calls.
- Add: `mirrornode.Client` wrapper for the remaining-allowance query.
- Add: `slack.Sender` wrapper (webhook + structured payload).
- Add: `fees.Calculator` interface + default impl + loader for private impl.
- Add: `audit.BuildEnvelope(...)` function producing the canonical JSON for outbox rows.

Please re-scope PR B accordingly and re-estimate. The outbox table + drain worker + M1/M2 parts are unchanged.

## References

- `reference-impl/README.md` — top-level description + porting guidance (will land in PR #9)
- `docs/DESIGN.md` — §3 (account model), §6 (plugin surface — now empty), §13 (audit outbox flow), §14 (test strategy), §16 (response shape — now simpler)
- `docs/RUNBOOKS.md` §Treasury replenishment — Slack channel names + runbook format
- Coordination log `memory/project_hedera_xeni_mcp_coordination.md` — the pivot discussion entries and decisions

## Contact

For questions on the reference TS code, contract edge cases, or test-case intent: H-MCP-Buddy. Loop through Anand if there's a design disagreement — the pivot rationale is above but specifics are open.
