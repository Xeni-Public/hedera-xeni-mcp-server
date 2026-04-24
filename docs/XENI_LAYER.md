<!-- Authored-by: Anand Palanisamy - anand@xeni.com -->

# Xeni layer on top of hedera-agent-kit v4

A concise inventory of the additions and conventions this repo adds on top of upstream `@hashgraph/hedera-agent-kit` + `@hashgraph/hedera-agent-kit-mcp` + `@hiero-ledger/sdk`. Read this to understand **what is ours** versus **what comes from upstream** without reading every file.

For the full architectural rationale, see [DESIGN.md](DESIGN.md). For the upstream-feature dependency surface we rely on, see [DESIGN_DEPENDENCIES.md](DESIGN_DEPENDENCIES.md). For ops procedures, see [RUNBOOKS.md](RUNBOOKS.md).

---

## 1. Design philosophy

- **Thin plugin on upstream, not a wrapper or fork.** The MCP server composes `allCorePlugins` (43 upstream tools) with one Xeni-owned plugin (`xeniReadPlugin`, 1 tool) and ships the full set through the upstream `HederaMCPToolkit`. No upstream code is modified or re-exported.
- **Single-client runtime.** The server runs as the `agent` account only. `operator` and `xeni_treasury` keys are cold — loaded exclusively by the standalone bootstrap scripts on an ops laptop, never by the running server. A runtime WARN fires if a cold-key env var leaks into the server process.
- **AUTONOMOUS mode only.** The MCP signs every tool transaction with the agent key. User-signed (`RETURN_BYTES`) flows — e.g., User A granting an allowance to the agent — live in AgentService, not in this MCP.
- **No business-logic plugins in the MCP.** After the Option D pivot (2026-04-20), the four intent-mandate guards + the account resolver moved to AgentService's Go port at `services/hederaGuards/`. This repo keeps the TypeScript `reference-impl/` tree as the **behavioral specification** the Go port mirrors — it is not registered on the toolkit.
- **Standalone migrations.** DB schema changes and on-chain bootstrap (`create_topic`, `create_account`, initial allowance grants) are explicit deploy steps run by Anand from an ops laptop. The server has no `prestart` migration hook and fails loudly on missing bootstrap env rather than auto-creating.

## 2. What we added on top of upstream

### 2.1 Server bootstrap (src/server.ts)

- `loadConfig()` — parses `HEDERA_NETWORK`, `HEDERA_TRANSPORT`, `HEDERA_HTTP_BIND`, `HEDERA_HTTP_PORT`, `NODE_ENV`, `HEDERA_ENV_LABEL`. Refuses to start if `NODE_ENV=production` + `HEDERA_TRANSPORT=http` (security rule per §8 of DESIGN.md).
- `buildToolkit(config)` — constructs the single `Client`, registers `allCorePlugins` + `xeniReadPlugin`, returns a `HederaMCPToolkit` in `AgentMode.AUTONOMOUS` mode. Upstream's `ToolDiscovery.createFromConfiguration` defaults `plugins` to `[]`, so we MUST name the core set explicitly — without this we would ship zero tools.

### 2.2 One Xeni-owned MCP tool (src/plugins/xeniRead/)

- `get_treasury_allowance_remaining` — thin Mirror Node REST wrapper that returns the remaining `treasury → agent` HBAR allowance. Gives AgentService's `TreasuryAllowanceGuard` a **single integration surface** instead of talking to Mirror Node directly. Fails loud on Mirror Node errors so the guard fails closed.
- Fields returned: `remainingHbar`, `ownerAccountId`, `spenderAccountId`, `humanMessage`. Deliberately narrow: no business logic, no caching (TTL cache deferred to Phase 2), no write path.
- Plugin registration name: `xeni_read`. Extensible to additional read-only wrappers if more single-surface-for-AgentService needs emerge; write / on-chain / signing logic never lives in this plugin.

### 2.3 Transport layer (src/transports/)

- `stdio.ts` — `StdioServerTransport` with graceful shutdown on `SIGTERM` / `SIGINT`. Production transport; AgentService spawns the MCP as a child process.
- `http.ts` — `startHttpServer(config)` with `StreamableHTTP` transport. **Dev-only.** Binds to `127.0.0.1` by default; configurable via `HEDERA_HTTP_BIND` for edge cases. Server refuses to start if `NODE_ENV=production` + HTTP transport (asserts cold attack surface — MCP exposes HBAR transfer tools, any unauthenticated external reachability = money drain).

### 2.4 Runtime account identity (src/accounts.ts)

- `loadAgentAccount()` — returns `{ accountId, privateKey }` from `HEDERA_AGENT_ID` + `HEDERA_AGENT_KEY`.
- `loadTreasuryAccountId()` — returns the public treasury account ID. **ID is public and safe at runtime** (used by `get_treasury_allowance_remaining`); only the treasury KEY is cold.
- `warnIfColdKeyLeaked()` — fires a WARN at startup if `HEDERA_OPERATOR_KEY` or `HEDERA_XENI_TREASURY_KEY` is present in the process env. Non-blocking; the WARN is the ops signal. See issue #21 for the cold-key invariant contract + the test-layer + workflow-layer regression guards.

### 2.5 Structured logger (src/logger.ts)

- `log.info` / `log.warn` / `log.error` / `log.debug` — structured key=value output to stderr; no emojis per team rule. Single source of truth for all runtime logging in `src/`. Not used by `scripts/` (scripts have their own injected `logStderr` / `printStdout` deps for testability).

### 2.6 Standalone bootstrap scripts (scripts/)

Per our migration-standalone team rule: these run on an ops laptop, never at server startup.

- `scripts/bootstrap-audit-topic.ts` (M3) — creates the global `xeni_audit` HCS topic for a target env. Admin key = operator's public key. Submit key = agent's public key (fetched from Mirror Node at bootstrap — bootstrap env never holds the agent private key). Idempotent via `HEDERA_XENI_AUDIT_TOPIC_ID` env + Mirror Node memo verification (issue #18 replacement for the broken memo-walk).
- `scripts/bootstrap-treasury.ts` (M4) — creates the dedicated `xeni_treasury` account + initial `treasury → agent` refund allowance. Prints the cold key to stdout exactly once; never re-retrievable. Idempotent via `HEDERA_XENI_TREASURY_ID` env + Mirror Node memo verification. Warns (does not fail) when `initialAllowance > balance`.
- `scripts/smoke-mirror-node.ts` (issue #22) — Mirror Node endpoint pre-flight smoke-check. Probes the four Mirror Node endpoints we depend on with HTTP 200 + shape-invariant assertions + `[prod-path]` / `[test-infra]` classification on failures. 3×5s serial retry per endpoint. Runs as a CI gate before `e2e-nightly`'s E2E step — short-circuits the E2E job if any endpoint is broken.
- `scripts/lib/bootstrapEnv.ts` — `loadBootstrapEnv()` shared by M3 + M4. Validates `HEDERA_OPERATOR_ID` / `HEDERA_OPERATOR_KEY` / `HEDERA_NETWORK` / `HEDERA_ENV_LABEL`.
- `scripts/lib/mirrorLookup.ts` — three Mirror Node helpers: `fetchTopicMemo`, `fetchAccountMemo`, `fetchAccountPublicKey`. URL-shape regression-guard unit tests lock each endpoint's path.
- `scripts/lib/mirrorSmoke.ts` — `probeEndpoint()` with DI'd fetch/sleep + four shape-assertion functions + `buildProbes()` factory. Pure logic; `smoke-mirror-node.ts` is the CLI wrapper.

### 2.7 Reference implementation (reference-impl/)

Behavioral specification, **not** registered on the MCP toolkit. AgentService's Go port at `services/hederaGuards/` mirrors these contracts; the TS code here is the authoritative spec. Kept in the repo so Go and TS engineers can read the same canonical behavior.

- `reference-impl/hbar.ts` — HBAR utilities (tinybar integer math, parse/format).
- `reference-impl/hooks/spendPolicyGuard.ts` — rejects `approve_hbar_allowance` when the requested amount exceeds the user's policy ceiling.
- `reference-impl/hooks/mandateBudgetGuard.ts` — rejects `transfer_hbar_with_allowance` when the amount would exceed the intent's remaining mandate.
- `reference-impl/hooks/treasuryAllowanceGuard.ts` — rejects refund transfers when they would exceed the treasury's remaining daily cap (queried via `get_treasury_allowance_remaining`). Emits a Slack alert at 80% consumed.
- `reference-impl/hooks/auditEnvelopeBuilder.ts` — builds the HCS audit envelope payload (does NOT submit; submission is the outbox worker's job).
- `reference-impl/policies/accountResolver.ts` — selects operator vs. agent Client per tool (for MCPs that run a dual-client model; our runtime uses single-client, but the spec is kept for future multi-role).
- `reference-impl/fees/FeeCalculator.ts` + `DefaultFeeCalculator.ts` — reference interface + default implementation for Xeni-MoR fee splits. Real fee logic lives in a private plugin if/when loaded at runtime.
- `reference-impl/tests/*` — spec tests that double as acceptance criteria for the Go port.

### 2.8 Audit event schema + durability design

Documented in [DESIGN.md](DESIGN.md) §5 + §13. The MCP does not own the outbox — AgentService writes envelopes into a local outbox table and a worker calls `submit_topic_message_tool` to drain them. Key invariants:

- No audit envelope exists for a failed transfer (AgentService enforces this via transaction boundary on its side).
- `event_id` (UUID v4) is the consumer-side dedup key — HCS does not dedupe natively. If the worker crashes between submit and outbox `UPDATE`, a retry resubmits; consumers dedupe on `event_id`.
- `schema_version`, `event_id`, `tx_timestamp`, `intent_id`, `customer_id` are mandatory; null-valued fields are omitted entirely (JSON size + cleanliness).

### 2.9 Test harness (test/)

- `test/unit/` — unit tests covering every `src/` + `scripts/lib/` module + the issue-#21 regression guards; `coverage.include` in `vitest.config.ts` names each file explicitly rather than lowering thresholds.
- `test/integration/` — integration tests for `buildToolkit` + HTTP transport lifecycle.
- `test/e2e/` — E2E on real testnet (`testnet-ci` env). Four suites:
  - `bootstrap-idempotency.e2e.test.ts` — M3 + M4 re-run against already-bootstrapped state; throw-if-called stubs guard CREATE paths so regressions fail loudly rather than racking up testnet cost.
  - `audit-flow.e2e.test.ts` — submit one HCS message, poll Mirror Node for round-trip.
  - `server-wiring.e2e.test.ts` — `buildToolkit()` + `get_treasury_allowance_remaining` round-trip.
  - `_helpers.ts` + shared `missingE2EEnv()` — skip-with-diagnostic pattern when testnet creds are absent.

### 2.10 Regression guards specific to our setup

- **URL-shape assertions** on every Mirror Node call — `test/unit/mirrorLookup.test.ts` pins the exact endpoint path so a future refactor can't silently revert to a non-existent list endpoint (issue #18 class of bug).
- **Cold-key invariant** — `test/unit/e2eHelpers.test.ts` (test-side) asserts `REQUIRED_BASE_ENV` does NOT demand operator creds; `test/unit/ciWorkflowColdKey.test.ts` (workflow-side) asserts `.github/workflows/ci.yml` does not assign `HEDERA_OPERATOR_KEY:` / `HEDERA_OPERATOR_ID:`. Together they close the #21 regression loop on both sides.
- **Mirror Node pre-flight smoke-check** — `scripts/smoke-mirror-node.ts` + the 29 unit tests for it (`test/unit/mirrorSmoke.test.ts` + `test/unit/smokeMirrorNode.test.ts`). CI gate, not a regression test, but lives in the same family: catch endpoint drift before E2E does.

### 2.11 CI pipeline (.github/workflows/ci.yml)

- Job 1 — `Lint + Build + Unit + Integration` on every PR: prettier, eslint, tsc, vitest unit + integration with coverage thresholds (statements ≥80%, branches ≥75%, functions ≥80%, lines ≥80%).
- Job 2 — `E2E on testnet-ci` runs on nightly cron (`0 10 * * *`) + on-demand `workflow_dispatch`. Secrets-gated (skips cleanly if `TESTNET_CI_*` absent).
- Pre-flight step on the E2E job — `Mirror Node pre-flight smoke-check` runs before the E2E vitest call; step failure short-circuits the E2E step via GitHub Actions default step-dependency semantics.
- Env block on the E2E job explicitly excludes `HEDERA_OPERATOR_ID` / `HEDERA_OPERATOR_KEY` (cold-key invariant — see issue #21).

### 2.12 Configuration + docs (.env.example, docs/)

- `.env.example` — all runtime + bootstrap env vars with placeholder values + dual-use docstrings where applicable (e.g., `HEDERA_XENI_AUDIT_TOPIC_ID` is both a runtime target and a bootstrap idempotency input).
- `docs/DESIGN.md` — authoritative v1 architecture doc (accounts, money flow, HCS topic model, audit durability, testing strategy, migration + cutover).
- `docs/DESIGN_DEPENDENCIES.md` — upstream features we rely on; breaking change in any = coordinated review before version bump. Renovate is configured to leave the three upstream deps alone.
- `docs/RUNBOOKS.md` — ops procedures (nightly refund-allowance top-up, cap-hit UX, mid-day extension, dead-letter response, operator-balance top-up, on-call escalation, allowance repair after M4 partial failure, cutover smoke-test checklist).
- `docs/HANDOVER_TO_AGENT_SERVICE.md` — Go port spec for AgentService's `services/hederaGuards/`.
- `CONTRIBUTING.md` — contributor checklist (pre-review + post-review items per issue #14).
- `SECURITY.md` — disclosure process.

## 3. What we chose NOT to add (for scope clarity)

- **No modifications to upstream packages.** All three pinned exact: `@hashgraph/hedera-agent-kit` 4.0.0, `@hashgraph/hedera-agent-kit-mcp` 1.0.0, `@hiero-ledger/sdk` 2.81.0. Renovate excluded.
- **No hand-rolled HBAR / HCS / allowance tools.** Upstream already ships all six on our hot path (`transfer_hbar`, `transfer_hbar_with_allowance`, `approve_hbar_allowance`, `delete_hbar_allowance`, `create_topic`, `submit_topic_message`).
- **No write plugin post-pivot.** The Option D decision moved business-logic guards to AgentService; our one plugin is read-only.
- **No hooks registered on the toolkit.** `reference-impl/hooks/` exists as specification only; it is not wired into `HederaMCPToolkit` at build time.
- **No HTS / USDC / stablecoin flows in v1.** Phase 2.
- **No outbox in the MCP.** AgentService owns the outbox table + worker; our MCP just exposes `submit_topic_message_tool` (upstream core) for the worker to call.
- **No LangChain / Vercel AI toolkit wiring.** Out of scope.
- **No scheduled transactions, no HCS-listener-triggered flows.** Phase 3.

## 4. Files added or updated (current state of `develop`)

All files listed here are Xeni-authored additions; all carry the `Authored-by: Anand Palanisamy - anand@xeni.com` header per team rule.

### 4.1 `src/` — MCP runtime

| File | Purpose |
|---|---|
| `src/server.ts` | `loadConfig()` + `buildToolkit(config)` — composes upstream core plugins + our `xeniReadPlugin` in AUTONOMOUS mode |
| `src/accounts.ts` | `loadAgentAccount()`, `loadTreasuryAccountId()`, `warnIfColdKeyLeaked()` (cold-key invariant WARN) |
| `src/logger.ts` | Structured key=value logger; no emojis; stderr-only |
| `src/transports/stdio.ts` | `StdioServerTransport` + SIGTERM/SIGINT graceful shutdown |
| `src/transports/http.ts` | Dev-only StreamableHTTP; loopback-only default; `NODE_ENV=production + http` refuses to start |
| `src/plugins/xeniRead/index.ts` | `xeniReadPlugin(deps)` factory |
| `src/plugins/xeniRead/mirrorNode.ts` | Mirror Node REST helper for the allowance lookup |
| `src/plugins/xeniRead/getTreasuryAllowanceRemaining.ts` | The `get_treasury_allowance_remaining` tool definition + factory |

### 4.2 `scripts/` — standalone bootstrap + smoke

| File | Purpose |
|---|---|
| `scripts/bootstrap-audit-topic.ts` | M3 — creates global `xeni_audit` HCS topic; idempotent via env + memo check |
| `scripts/bootstrap-treasury.ts` | M4 — creates `xeni_treasury` account + initial refund allowance; idempotent |
| `scripts/smoke-mirror-node.ts` | Mirror Node pre-flight smoke-check (issue #22); CI gate before E2E |
| `scripts/lib/bootstrapEnv.ts` | Shared env loader used by M3 + M4 |
| `scripts/lib/mirrorLookup.ts` | Mirror Node REST helpers: `fetchTopicMemo`, `fetchAccountMemo`, `fetchAccountPublicKey` |
| `scripts/lib/mirrorSmoke.ts` | Smoke-check primitives: `probeEndpoint`, shape assertions, `buildProbes` |

### 4.3 `reference-impl/` — behavioral spec (not registered on the toolkit)

| File | Purpose |
|---|---|
| `reference-impl/README.md` | Context for AgentService port engineers |
| `reference-impl/hbar.ts` | HBAR tinybar-integer math utilities |
| `reference-impl/logger.ts` | Spec logger (for reference-impl tests) |
| `reference-impl/hooks/spendPolicyGuard.ts` | Spec for `approve_hbar_allowance` ceiling guard |
| `reference-impl/hooks/mandateBudgetGuard.ts` | Spec for `transfer_hbar_with_allowance` mandate guard |
| `reference-impl/hooks/treasuryAllowanceGuard.ts` | Spec for refund-cap guard + 80% Slack alert |
| `reference-impl/hooks/auditEnvelopeBuilder.ts` | Spec for audit envelope builder (outbox input) |
| `reference-impl/policies/accountResolver.ts` | Spec for operator-vs-agent client resolver |
| `reference-impl/fees/FeeCalculator.ts` | Spec fee-calculator interface |
| `reference-impl/fees/DefaultFeeCalculator.ts` | Reference default implementation |
| `reference-impl/tests/*` | 6 spec tests — acceptance criteria for the Go port |

### 4.4 `test/` — unit + integration + E2E

| File | Purpose |
|---|---|
| `test/unit/mirrorLookup.test.ts` | Mirror Node helpers + URL-shape regression guards |
| `test/unit/mirrorNode.test.ts` | `src/plugins/xeniRead/mirrorNode.ts` unit tests |
| `test/unit/mirrorSmoke.test.ts` | `probeEndpoint` + shape assertions + `buildProbes` |
| `test/unit/smokeMirrorNode.test.ts` | `runSmoke` orchestrator tests |
| `test/unit/bootstrapEnv.test.ts` | `loadBootstrapEnv` unit tests |
| `test/unit/bootstrapAuditTopic.test.ts` | M3 `runBootstrap` unit tests |
| `test/unit/bootstrapTreasury.test.ts` | M4 `runBootstrap` unit tests |
| `test/unit/getTreasuryAllowanceRemaining.test.ts` | The one Xeni-owned tool's unit tests |
| `test/unit/logger.test.ts` | Logger unit tests |
| `test/unit/e2eHelpers.test.ts` | Cold-key invariant regression guards (test-side) — issue #21 |
| `test/unit/ciWorkflowColdKey.test.ts` | Cold-key invariant regression guards (workflow-side) — issue #21 |
| `test/integration/server.test.ts` | `buildToolkit` + cold-key WARN integration |
| `test/integration/http-transport.test.ts` | HTTP transport lifecycle |
| `test/e2e/_helpers.ts` | `missingE2EEnv` — skip-with-diagnostic helper |
| `test/e2e/bootstrap-idempotency.e2e.test.ts` | M3 + M4 re-run paths against real Mirror Node |
| `test/e2e/audit-flow.e2e.test.ts` | Submit + Mirror-Node-poll round-trip |
| `test/e2e/server-wiring.e2e.test.ts` | `buildToolkit` + treasury-allowance-remaining on real testnet |

### 4.5 `docs/` — architecture, ops, onboarding

| File | Purpose |
|---|---|
| `docs/DESIGN.md` | v1 architecture — accounts, money flow, HCS topic model, audit durability, testing, cutover |
| `docs/DESIGN_DEPENDENCIES.md` | Upstream features we depend on; breaking-change review policy |
| `docs/RUNBOOKS.md` | Ops procedures (refund top-up, cap-hit, dead-letter, cutover smoke-test, allowance repair) |
| `docs/HANDOVER_TO_AGENT_SERVICE.md` | Go port spec for AgentService's `services/hederaGuards/` |
| `docs/XENI_LAYER.md` | This file |

### 4.6 Root-level project + config

| File | Purpose |
|---|---|
| `README.md` | Project overview + upstream-leverage table + naming-convention explainer |
| `CONTRIBUTING.md` | Pre-review + post-review PR checklist (post-review block added by PR #25 / issue #14) |
| `SECURITY.md` | Security disclosure process |
| `LICENSE` | Apache-2.0 |
| `package.json` | Pinned-exact upstream deps + all `npm run` scripts (test / build / bootstrap / smoke) |
| `package-lock.json` | Lockfile |
| `.env.example` | Runtime + bootstrap env vars with per-var docstrings |
| `.eslintrc.cjs` | ESLint config (recommended + type-checking + custom rules) |
| `.prettierrc` | Prettier config |
| `.gitignore` | Standard TS/Node ignores |
| `.npmrc` | `legacy-peer-deps=true` for dependency resolution |
| `tsconfig.json` | TS build config (`src/` + `scripts/` + `reference-impl/`) |
| `tsconfig.eslint.json` | Wider TS project for ESLint to cover `test/` without emitting test build output |
| `vitest.config.ts` | Unit + integration + reference-impl test config; `coverage.include` explicit per-file |
| `vitest.e2e.config.ts` | Separate config for the nightly E2E run; coverage disabled |
| `.github/workflows/ci.yml` | Two jobs: lint-build-test on every PR; E2E on nightly cron + workflow_dispatch, with the Mirror Node pre-flight smoke-check step gating E2E |

## 5. What comes from upstream unchanged

For completeness — these are not ours, and we do not modify them:

- **43 MCP tools** from `allCorePlugins` — the full list can be derived by importing `@hashgraph/hedera-agent-kit/plugins` and reading `allCorePlugins`'s composition (10 plugins: `coreAccount`, `coreToken`, `coreConsensus`, `coreEVM`, and their query counterparts + `coreMiscQueries` + `coreTransactionQuery`).
- **`HederaMCPToolkit`** from `@hashgraph/hedera-agent-kit-mcp` — the MCP-protocol toolkit that registers tools + dispatches JSON-RPC requests.
- **`AgentMode` + `Context` + `BaseTool` + `Plugin`** types from `@hashgraph/hedera-agent-kit`.
- **`Client`, `PrivateKey`, `PublicKey`, transaction builders** from `@hiero-ledger/sdk`.
- **Hook + policy system** in `@hashgraph/hedera-agent-kit` — we do not use it in runtime post-pivot, but the spec for our previous guard architecture is in `reference-impl/`.

## 6. Currency conversion (HBAR ↔ fiat)

User-facing prices are quoted in fiat (USD today; EUR / INR / etc. in Phase 2). Every HBAR budget / allowance / payment number is reconciled to fiat somewhere in the flow — search results display fiat, intents carry both `budget_hbar` and `max_price` USD, Slack alerts show fiat-equivalent of remaining treasury allowance. **All fiat reconciliation is dynamic and per-request** — never hardcoded, never cached beyond a single request's lifetime.

### 6.1 Tool: `get_exchange_rate_tool` (upstream)

Already registered on our toolkit via `allCorePlugins` (`coreMiscQueriesPlugin`). Wraps Mirror Node's `/api/v1/network/exchangerate`.

- **Scope:** HBAR ↔ **USD only** — this is Hedera's own consensus-layer fee-rate, not a general FX oracle.
- **Parameters:** `timestamp` (optional) for historical rates; omit for current.
- **Response shape:**

  ```json
  {
    "current_rate": {
      "cent_equivalent": 596987,
      "hbar_equivalent": 30000,
      "expiration_time": 1776925010
    },
    "next_rate": { ... },
    "timestamp": "1776924000.000000000"
  }
  ```

  Type note: `cent_equivalent`, `hbar_equivalent`, and `expiration_time` are all **numbers** (with `expiration_time` in Unix seconds). `timestamp` is a **string** (Mirror Node's consensus-timestamp format `seconds.nanos`). Parse `expiration_time` as a number; parsing it as a string will yield `NaN` downstream.

- **What it does NOT do:** take a fiat amount and return an HBAR amount (and vice versa). The tool returns a **rate**; the caller does the math.

### 6.2 Conversion formulas

Given `{cent_equivalent, hbar_equivalent}` from the tool response:

```
HBAR → USD:  usd  = hbar * (cent_equivalent / hbar_equivalent) / 100
USD  → HBAR: hbar = usd  * (hbar_equivalent / cent_equivalent) * 100
```

Worked example with `cent_equivalent=596987`, `hbar_equivalent=30000`:

- `1 HBAR  → $0.199`
- `$50    → 251.3 HBAR`

Callers should compute in the smallest unit they care about (tinybar / cents) to avoid floating-point drift on rounded intermediate values.

### 6.3 Dynamic-conversion convention

| Convention | Rationale |
|---|---|
| **Call `get_exchange_rate_tool` at the moment the conversion is needed.** Don't cache the rate beyond the life of the request. | Mirror Node updates the consensus rate approximately every 15 minutes. Caching risks quoting a stale price at commit time, especially on long-running booking flows. |
| **Never hardcode a rate.** | Same reason. Also protects against test-env drift. |
| **Store both sides when persisting.** | Audit events, intent rows, HCS envelopes SHOULD carry both the HBAR amount and the USD-equivalent AT TX TIME. The rate at audit replay time will differ; storing both values is cheap and makes post-hoc reconciliation deterministic. |
| **Fail fast on zero / negative components.** | A `cent_equivalent` or `hbar_equivalent` of 0 means Mirror Node returned garbage — surface this rather than compute a `NaN` or `Infinity` downstream. |

**Known transitional exception (2026-04-23):** AgentService's forward-payment (`services/intentService/payment_outcome.go`) + refund (`approveService.go`) paths currently use a static config-rate (`coingecko.static_hbar_rate`) set at service start, not a per-request `get_exchange_rate_tool` call. Migration tracked in [ai-agent-api-service #90](https://github.com/xeni-app/ai-agent-api-service/issues/90). Until that lands, live code on those two paths diverges from the convention above — any **new** code or flow should still follow the dynamic-per-request rule.

### 6.4 Multi-currency gap (Phase 2)

Mirror Node only serves HBAR/USD. For **EUR, INR, GBP, or any other fiat**, we'd need an external oracle — CoinGecko (primary candidate), or equivalent. Not shipped in v1.

Candidate Xeni-owned tool when the need arises: `get_hbar_fiat_rate` wrapping CoinGecko's `/simple/price?ids=hedera-hashgraph&vs_currencies=...`, with the same "dynamic per-request + fail-fast" posture as `get_treasury_allowance_remaining`.

Until then, **anything that needs non-USD fiat must be converted outside this MCP** (usually on the frontend or AgentService via its own FX helper), and the result passed into MCP calls as already-converted HBAR amounts.

## 7. References

- [DESIGN.md](DESIGN.md) — full architectural rationale
- [DESIGN_DEPENDENCIES.md](DESIGN_DEPENDENCIES.md) — upstream dependencies
- [RUNBOOKS.md](RUNBOOKS.md) — ops procedures
- [HANDOVER_TO_AGENT_SERVICE.md](HANDOVER_TO_AGENT_SERVICE.md) — Go port spec
- [CONTRIBUTING.md](../CONTRIBUTING.md) — contributor checklist
- Upstream: [hedera-agent-kit v4](https://github.com/hashgraph/hedera-agent-kit)
