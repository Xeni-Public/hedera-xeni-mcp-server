<!-- Authored-by: Anand Palanisamy - anand@xeni.com -->

# USDC support — Phase 2 design

**Status:** v1 design lock. Pending Lead Buddy review + cross-repo coordination on the open items in §13.

**Source decisions locked 2026-04-28** via 7-Q product call (see §3 below). This document is the authoritative spec; implementation PRs (Phase 2.1–2.7) MUST mirror its contracts. Behavioral changes go through coordination log first, then this doc, then implementation.

> ⚑ **Design relationship with DESIGN.md:** `DESIGN.md` is the canonical v1 (HBAR-only) spec. This doc extends it for USDC; it does NOT replace any v1 invariants. Sections marked **EXTENDS** modify a v1 section's scope; sections marked **NEW** add concepts that don't exist in v1.

## 1. Purpose

Add USDC (Hedera-native HTS token) as a parallel-currency payment channel to v1's HBAR-only money flow. Same MoR model, same allowance pattern, same audit-via-HCS posture — just with the HTS token toolset instead of HBAR primitives.

Mainnet-prod target for v2 launch. Testnet (testnet-ci + testnet-uat) is the full testing path; mainnet promotion is gated on testnet success.

## 2. Why USDC (and not HBAR-only forever)

- **User reach.** HBAR-only restricts the user pool to Hedera-native wallet holders with HBAR balances. USDC opens up the stablecoin-holding user base — much larger.
- **Stable pricing.** A $50 booking quoted in HBAR fluctuates with the HBAR/USD rate during the booking flow. USDC is dollar-pegged; the price the user sees IS the price they pay.
- **Refund predictability.** Same as pricing — a $50 refund means $50 received, not "$50 minus rate drift over the booking-to-cancel window."
- **No on-ramp friction for USDC holders.** Many users already hold USDC on Ethereum / Polygon / Solana; bridging to Hedera USDC is one step, vs. acquiring HBAR from scratch.

## 3. Decision log (7 questions, all locked)

| # | Question | Decision | Why |
|---|---|---|---|
| 1 | Product priority — v2 launch or post-launch fast-follow? | v2 launch, mainnet-prod | Locks the timeline; design + impl must be ready before mainnet cutover |
| 2 | Pricing display format | `50 USDC` (trailing currency code), optional logo prefix | Matches existing `50 HBAR` convention; consistent UX across currencies |
| 3 | Wallets in scope | HashPack (native Hedera) + MetaMask (EVM via HashIO + EIP-2612 `permit`) | HashPack covers Hedera-native users; MetaMask covers EVM-DeFi users; together = broad reach |
| 4 | Cross-currency refunds? | **No.** Same currency only. | Cross-currency adds rate-risk + slippage + bridge complexity — out of scope for v1 of USDC |
| 5 | Bootstrap script granularity | One M5 (treasury+agent association + USDC allowance + initial USDC funding) | Matches M4's pattern; single atomic ops step |
| 6 | Agent HBAR funding source | Operator reserves (existing cold-key pattern) | No new account; reuses bootstrap + emergency top-up procedure already in place |
| 7 | Cost recovery for HBAR fees | Price the ~$0.10/booking HBAR cost into the booking total (rolled into headline, not itemized) | Cleaner UX than a transparent service-fee line; transparency preserved in audit envelope |

## 4. Architecture overview

USDC support is **a parallel pipeline**, not a replacement:

```
                              ┌────────────────────┐
       (HBAR payments)        │                    │       (USDC payments)
User ───approve_hbar_         │ AgentService       │ ───approve_token_
      allowance──► Agent      │ (routes by intent  │     allowance ──► Agent
                              │  currency)         │
Agent ──transfer_hbar_with_   │                    │ ──transfer_fungible_token_
       allowance──► Treasury  │                    │     with_allowance──► Treasury
                              └────────────────────┘
       (HBAR refunds)                                      (USDC refunds)
Treasury ──approve_hbar_              ←══════════               Treasury ──approve_token_
          allowance──► Agent                                              allowance──► Agent
Agent ──transfer_hbar_with_                                     Agent ──transfer_fungible_token_
       allowance──► User                                               with_allowance──► User
```

**The intent's currency is fixed at booking time and immutable across the lifecycle.** A USDC intent stays USDC through payment, audit, and refund. No mid-flight conversions, no rate exposure.

### Fee delegation (architectural commitment)

**Users never need HBAR for transaction fees.** Every user-touching transaction is constructed with `payerAccountId: agent`. The user wallet signs (because the user's state changes — their allowance or association), but the **agent account pays the HBAR fee on submit.**

This is a hard requirement, not a nice-to-have. See §8 for per-wallet realization.

## 5. EXTENDS — Account model (DESIGN.md §3)

No new accounts. Existing roles take on parallel USDC responsibilities:

| Role | v1 (HBAR) | + Phase 2 (USDC) |
|---|---|---|
| `operator` | Bootstrap + emergency top-ups | + funds agent HBAR fee buffer (existing pattern; new top-up cadence) |
| `agent` | Sole runtime signer; signs transfers + audit | + pays HBAR fees for user-signed transactions (fee delegation); + holds USDC associations |
| `xeni_treasury` | Holds HBAR; signs HBAR allowance grants (cold) | + holds USDC; + signs USDC allowance grants (cold, same cold-key pattern) |

**Token associations** (HTS-specific requirement):

- `xeni_treasury` MUST associate USDC before it can receive payments.
- `agent` MUST associate USDC even though it never holds USDC — allowance grants require the spender account to be associated.
- End users MUST associate USDC in their wallet before paying. **Fee for this association is paid by `agent` via `payerAccountId` delegation** (§8).

## 6. NEW — Token IDs and per-env config

Hedera Service IDs differ per network:

| Network | USDC token ID | Source of truth |
|---|---|---|
| testnet | `0.0.429274` | Circle's testnet USDC; verify at design-lock time via Mirror Node `/api/v1/tokens/{id}` |
| mainnet | `0.0.456858` | Circle's mainnet USDC; verify at design-lock time |

> **Verify-before-trust rule.** Hardcoded IDs from public docs MUST be confirmed against live Mirror Node responses at design-lock time. Issue #18 (the broken endpoint) taught us this lesson; same discipline applies to Circle's published token IDs.

**Per-env env var (`.env.example` SECTION A.6 — new):**

```bash
# ---- A.6 USDC token ID (REQUIRED for Phase 2 USDC payments) ----
# Hedera HTS token ID for Circle's USDC on this network.
# Canonical IDs (verify per env before use):
#   testnet: 0.0.429274
#   mainnet: 0.0.456858
# Verification: GET ${HEDERA_MIRROR_NODE_URL}/api/v1/tokens/${id} should
# return Circle's published symbol + decimals=6.
HEDERA_USDC_TOKEN_ID=0.0.429274
```

**Fail-fast posture** identical to `HEDERA_MIRROR_NODE_URL` (PR #30): missing or empty → server + bootstrap script refuse to start with a clear "Required env var missing" message.

## 7. Precision conventions (NEW)

| Currency | Decimals | Smallest unit | Existing util | New util needed |
|---|---|---|---|---|
| HBAR | 8 | tinybar (10⁻⁸) | `reference-impl/hbar.ts` | — |
| USDC on Hedera | 6 | micro-USDC (10⁻⁶) | — | `reference-impl/usdc.ts` parallel to `hbar.ts` |

`reference-impl/usdc.ts` exports:

```typescript
export function toMicroUSDC(usdc: number): bigint;
export function fromMicroUSDC(micro: bigint): number;
export function invalidNumberReason(value: unknown, name: string): string | null;
```

Mirrors `hbar.ts`'s API surface exactly — same `invalidNumberReason` shape so AgentService's Go port has parallel structure.

**Number safety:** USDC max supply is bounded by Circle's mint cap (~$25B mainnet). Max micro-USDC ≈ 2.5×10¹⁶ — comfortably within `Number.MAX_SAFE_INTEGER` (≈9×10¹⁵... actually beyond). **Use `bigint` internally for amounts**, convert to `number` only at JSON boundaries with explicit precision-loss accept (string `amount_decimal` field carries the safe value; see §9).

## 8. NEW — Fee delegation per wallet

The "user never holds HBAR" commitment is delivered differently per wallet:

### 8.1 HashPack (native Hedera)

Native Hedera transactions support a `payerAccountId` field that differs from the signer. Frontend constructs transactions with the agent as fee payer:

```typescript
// Frontend — HashPack path
const tx = new TokenAssociateTransaction()
  .setAccountId(userAccountId)
  .setTokenIds([usdcTokenId])
  .setTransactionId(TransactionId.generate(agentAccountId))  // ← agent pays
  .freeze();

const signedTx = await hashpack.signTransaction(tx);  // user signs
await agent.submit(signedTx);                          // agent submits + pays HBAR
```

Works out of the box; no new contracts, no relayer infrastructure.

### 8.2 MetaMask (EVM via HashIO + EIP-2612 `permit`)

MetaMask is Ethereum-native; talks to Hedera through HashIO (JSON-RPC bridge). USDC on Hedera also exposes an EVM facet — but the default EVM transaction model has the originator pay gas.

**Solution:** EIP-2612 `permit` pattern.

- User signs an **off-chain permit message** in MetaMask (cryptographic signature, no on-chain transaction, no gas)
- Agent submits a transaction that consumes the permit (calls `permit(...)` + `transferFrom(...)` in one EVM tx) and pays the HBAR gas

```typescript
// Frontend — MetaMask path
const permit = {
  owner: userEvmAddress,
  spender: agentEvmAddress,
  value: amountMicroUSDC,
  nonce: await usdcContract.nonces(userEvmAddress),
  deadline: Math.floor(Date.now() / 1000) + 3600,
};
const signature = await metamask.signTypedData(EIP712_DOMAIN, EIP712_TYPES, permit);

// Agent-side: submit a single tx that does permit + transferFrom
await agentSubmitter.submitPermitAndTransfer(permit, signature);
```

**Design-lock-time verification (BLOCKER for Phase 2.0 sign-off):**
- Confirm Circle's USDC contract on Hedera implements `permit` (EIP-2612). It does on Ethereum, Polygon, Arbitrum, Base, OP, Avalanche; Hedera is highly likely but **must be confirmed by reading the contract's interface on Hedera EVM at design-lock time.**
- Fallback if not supported: ERC-2771 trusted-forwarder pattern (Option B in the original design-call). Adds a contract-deployment surface — schedule a separate spike.

### 8.3 Per-call fee budget

| Operation | Fee paid by | One-time per user, or per call? | Estimated HBAR cost |
|---|---|---|---|
| USDC `TokenAssociate` (user account) | Agent (delegated) | One-time per user account, ever | ~$0.05 |
| User → Agent `approve_token_allowance` | Agent (delegated) | Per booking (allowance is single-use per intent) | ~$0.001 |
| Agent → Treasury `transfer_fungible_token_with_allowance` | Agent | Per booking | ~$0.001 |
| Audit `submit_message` (×~5 events per booking) | Agent | Per booking | ~$0.001 |
| Treasury → Agent `approve_token_allowance` for refund | Treasury (cold-key, ops laptop) | Periodic (nightly top-up) | ~$0.001 |
| Agent → User refund `transfer_fungible_token_with_allowance` | Agent | Per refund | ~$0.001 |

**Per-booking aggregate: ~$0.01–$0.10 in HBAR fees.** The TokenAssociate one-time cost dominates first-booking economics; subsequent bookings are cheap. **Price-in policy (decision 7) rolls all of this into the booking headline.**

## 9. EXTENDS — Audit event schema (DESIGN.md §13.5)

Bump schema from v1 to **v2** to carry currency information. Backward-compatible — v1 readers ignoring unknown fields still work for HBAR events.

```json
{
  "schema_version": 2,
  "event_id": "uuid-v4-...",
  "event": "payment_executed",
  "tx_timestamp": "2026-04-28T15:30:00Z",
  "intent_id": "...",
  "customer_id": "...",

  // NEW in v2 — currency context
  "currency": "USDC",                  // "HBAR" | "USDC"
  "token_id": "0.0.456858",            // null for HBAR; required for HTS
  "amount_token_units": 50000000,      // integer; smallest unit (tinybar / micro-USDC)
  "amount_decimal": "50.000000",       // string; safe render value, no FP drift

  // Existing fields (renamed for clarity in v2):
  "user": "0.0.userA",
  "destination": "xeni_treasury",
  "txId": "...",

  "split_accounting": {                // Same shape; values are in `currency` units
    "supplier_cost": 40.0,
    "platform_fee": 5.0,
    "customer_commission": 5.0
  },

  // NEW in v2 — explicit fee-budget tracking (decision 7)
  "fee_buffer_token_units": 100000,    // The HBAR-fee-equivalent in tx currency (~$0.10)
                                       // priced into the booking total (decision 7)
                                       // — for accounting, NOT for UI display.
                                       // Always present on `payment_executed`.

  "booking_ref": "..."
}
```

**Backward-compat rules:**
- v1 HBAR events: keep emitting `schema_version: 1` for at least 30 days post-v2 rollout, OR re-emit as v2 with `currency: "HBAR"`, `token_id: null`, `amount_token_units: <tinybar>`, `amount_decimal: <hbar-as-string>`.
- v2 readers MUST handle both `schema_version: 1` and `schema_version: 2`.
- AgentService outbox writer + AgentService HCS audit consumer both upgrade in the same release.

**Null-omission rule (v1 §13.5):** still applies. `token_id` MAY be omitted entirely on HBAR events (rather than `null`) to save bytes.

## 10. NEW — Xeni-authored MCP tool addition

Add `get_treasury_token_allowance_remaining` (sibling to v1's `get_treasury_allowance_remaining`):

```typescript
// src/plugins/xeniRead/getTreasuryTokenAllowanceRemaining.ts
export interface GetTreasuryTokenAllowanceRemainingDeps {
  treasuryAccountId: string;
  agentAccountId: string;
  tokenId: string;                     // ← NEW (this is what differs from HBAR version)
  network: string;                     // log context only
  mirrorNodeUrl: string;               // required; same fail-fast as v1
  fetchImpl?: FetchFn;
  timeoutMs?: number;
}

export interface GetTreasuryTokenAllowanceRemainingResult {
  remainingMicroTokenUnits: number;    // bigint serialized as Number (audit-safe range)
  remainingDecimal: string;            // "1000.000000" — UI-renderable
  tokenId: string;
  ownerAccountId: string;
  spenderAccountId: string;
}
```

Why separate tool (rather than extending existing):
- Upstream's HBAR and token allowance tools are separate (`approve_hbar_allowance` vs. `approve_token_allowance`); our read tools mirror that split.
- AgentService's existing `get_treasury_allowance_remaining` call has a stable contract; backwards-compat preserved by not changing its signature.

Endpoint: Mirror Node `GET /api/v1/accounts/${treasuryId}/allowances/tokens?spender.id=${agentId}&token.id=${tokenId}`.

## 11. NEW — Bootstrap script M5

`scripts/bootstrap-usdc.ts` — runs on ops laptop, post-M4. Does (in order):

1. **Verify token ID** — Mirror Node lookup confirms `HEDERA_USDC_TOKEN_ID` matches Circle's symbol + decimals=6. Throw with clear message if mismatch.
2. **Associate USDC on treasury** — `TokenAssociateTransaction(treasury)` signed by cold treasury key, fee paid by operator.
3. **Associate USDC on agent** — `TokenAssociateTransaction(agent)` signed by agent key (loaded for this one-shot), fee paid by operator.
4. **Optional initial USDC funding** — `TransferTransaction(operator → treasury, X USDC)` if `HEDERA_USDC_INITIAL_TREASURY_BALANCE` env var is set. Most envs leave this empty; mainnet pulls USDC via Circle / exchange instead.
5. **Grant treasury → agent USDC refund allowance** — `AccountAllowanceApproveTransaction` signed by cold treasury key. Amount from `HEDERA_USDC_REFUND_DAILY_CAP_USDC`.
6. **Verify all five state transitions on Mirror Node** before exit.

**DI pattern matches M3 / M4:** `runBootstrap(input, deps)` orchestrator; SDK wrappers v8-ignored; unit tests cover all branches with mocked Mirror Node + key generation.

**Idempotency:** parallel to M4 — env-var `HEDERA_USDC_TOKEN_ID` + Mirror Node verification gives "already done" path. Re-runs are safe; they verify state without mutating.

**Cold-key handling:** treasury key printed once during M4 — M5 reads it from a separate env var `HEDERA_XENI_TREASURY_KEY` populated for this one-off run (same pattern as M4 reading operator key). Cold-key invariant intact.

## 12. EXTENDS — Cross-repo coordination matrix

| Repo | What changes | Owner | Tracking |
|---|---|---|---|
| **hedera-xeni-mcp-server** (this repo) | All §5–11 above. Phases 2.0 → 2.4. | H-MCP-Buddy | This doc + Phase 2.x PRs |
| **ai-agent-api-service** (AgentService) | Currency router on intent state machine; per-currency allowance guards; schema-v2 audit envelope consumer; USDC daily-cap config; outbox writer schema upgrade | AgentService-Buddy | NEW issue to file post-2.0 design-lock |
| **ai-agent-web** (Frontend) | Currency selection UX on intent; USDC display + logo; HashPack + MetaMask wallet integration; EIP-2612 permit flow; USDC association flow; balance display; refund display | Frontend-Buddy | NEW issue filed in parallel with this PR (see end of this doc) |
| **xeni-ai-go-core** + Falcon (Pricing API) | Booking quotes expose USDC option; per-currency pricing logic | XeniMCP-Buddy or Lead-Buddy (TBD) | NEW issue to file at Phase 2.5 start |
| **Ops runbook** (`docs/RUNBOOKS.md`) | New section: agent HBAR fee-budget monitoring + replenishment. New section: USDC daily-cap replenishment (mirrors HBAR section) | H-MCP-Buddy | Bundled into Phase 2.6 |

## 13. Open follow-ups for design-lock-time verification

These MUST be resolved before merging implementation PRs:

| # | Item | Owner | Blocking? |
|---|---|---|---|
| L1 | Verify Circle's testnet + mainnet USDC token IDs against current Mirror Node `/api/v1/tokens/{id}` response | H-MCP-Buddy | Yes — config can't lock until confirmed |
| L2 | Verify Circle's USDC on Hedera implements EIP-2612 `permit` (Solidity ABI check) | H-MCP-Buddy + Frontend-Buddy | Yes — fallback to ERC-2771 forwarder is a separate spike |
| L3 | Confirm Circle's freeze-account behavior on Hedera (does Circle's compliance layer have freeze authority on Hedera USDC?) | H-MCP-Buddy (research) | No — but document the answer in runbook §"Treasury account compromised by upstream freeze" |
| L4 | HashPack's typed-data signing surface for native Hedera fee delegation (confirm `transactionId.accountId = agent` works through wallet adapter) | Frontend-Buddy | Yes for Phase 2.5 |
| L5 | AgentService confirms `mcp_env_test.go` cardinality bump path for the new env vars (parallel to PR #30's pattern) | AgentService-Buddy | Yes for Phase 2.1 |

## 14. Phased delivery (2.0 → 2.7)

| Phase | Scope | Owner | UAT signal |
|---|---|---|---|
| **2.0** | This design doc + cross-repo issues filed | H-MCP-Buddy | Lead approval + L1–L5 closed |
| **2.1** | `reference-impl/usdc.ts` + tests; Mirror Node smoke-check extended with token-allowance endpoint; `HEDERA_USDC_TOKEN_ID` env (fail-fast) | H-MCP-Buddy | 278+ unit tests pass; smoke-check verifies new endpoint |
| **2.2** | `get_treasury_token_allowance_remaining` tool shipped | H-MCP-Buddy | E2E reads testnet USDC allowance against Mirror Node |
| **2.3** | M5 bootstrap script (`scripts/bootstrap-usdc.ts`) | H-MCP-Buddy | Manual run on testnet-ci associates USDC on treasury+agent; HashScan verified |
| **2.4** | Audit envelope schema v2 (`reference-impl/hooks/auditEnvelopeBuilder.ts` + Go port mirror) | H-MCP-Buddy + AgentService-Buddy | Schema v2 events round-trip through outbox + HCS |
| **2.5** | AgentService routes USDC intents through token tools; Frontend wallet flows ready; first end-to-end testnet USDC booking | AgentService + Frontend | First testnet USDC payment + audit visible |
| **2.6** | Refund path (USDC); ops runbook updates; agent HBAR monitoring | AgentService + H-MCP-Buddy | First testnet USDC refund end-to-end |
| **2.7** | Mainnet-prod cutover: repeat M5 on mainnet, fund treasury, flip per-env config | Anand + H-MCP-Buddy | First mainnet USDC booking + refund |

## 15. Out of scope (Phase 3+ deferrals)

Explicit non-goals for v1 of USDC:

- **Auto-conversion HBAR ↔ USDC at runtime.** No DEX swaps inside our flow. If user paid HBAR, refund HBAR. If they want to switch currencies mid-flight, they cancel + rebook.
- **Multi-stablecoin support** (USDT, EURC, DAI, etc.). Once USDC works, adding a second stablecoin is repetition — design is templatable but not pre-built.
- **USDC ↔ USD rate verification.** Trust the peg for v1. Phase 3 if peg-deviation handling becomes a product requirement (e.g., compliance flagging during a depeg event).
- **Token-freeze recovery procedure.** If Circle freezes the treasury USDC account under sanctions, that's an off-chain process with Circle's compliance team. Document the contact path in the runbook; do NOT automate.
- **Native HTS allowances on the spender side beyond the v1 pattern.** Treasury → agent USDC allowance follows the v1 cold-key signing pattern.
- **CoinGecko or other multi-currency oracle integration** (XENI_LAYER.md §6.4 Phase 2 candidate). Still deferred; USDC's USD peg is trusted.

## 16. References

### Internal
- [DESIGN.md](DESIGN.md) — canonical v1 (HBAR-only) design
- [XENI_LAYER.md](XENI_LAYER.md) — orientation: Xeni layer vs. upstream
- [XENI_LAYER.md §6 — Currency conversion](XENI_LAYER.md#6-currency-conversion-hbar--fiat) — dynamic per-request convention (still applies to USD↔HBAR for HBAR pricing)
- [HANDOVER_TO_AGENT_SERVICE.md](HANDOVER_TO_AGENT_SERVICE.md) — Go port spec (USDC guards will mirror HBAR guards)
- [RUNBOOKS.md](RUNBOOKS.md) — to be extended with USDC sections at Phase 2.6

### External
- Hedera HTS — https://docs.hedera.com/hedera/core-concepts/tokens
- Hedera EVM (HashIO) — https://docs.hedera.com/hedera/core-concepts/smart-contracts/json-rpc-relay
- EIP-2612 `permit` — https://eips.ethereum.org/EIPS/eip-2612
- EIP-2771 trusted forwarder (Option B fallback) — https://eips.ethereum.org/EIPS/eip-2771
- Circle USDC on Hedera — https://www.circle.com/usdc/hedera (verify token IDs here)
- Upstream HTS tools surface — `@hashgraph/hedera-agent-kit` `coreTokenPlugin` (already registered via `allCorePlugins`)

### Cross-repo PR / issue links (populated as Phase 2.1+ ships)

- _Phase 2.1 PR: TBD_
- _AgentService coordination issue: TBD_
- _Frontend coordination issue: TBD (filed in parallel with this PR — see merge body)_
