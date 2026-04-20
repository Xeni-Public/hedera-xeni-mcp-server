<!-- Authored-by: Anand Palanisamy - anand@xeni.com -->

# Design Dependencies

Upstream features this server relies on. Breaking changes in any of these require coordinated review before we version-bump.

## Exact-pin policy

Per Lead Buddy review item 2: these three packages are **pinned to exact versions** (no `^` or `~`) in `package.json`. Renovate / Dependabot are excluded from auto-bumping them (see `renovate` block in `package.json`).

Why: `hedera-agent-kit-js` v4 is bleeding edge (released 2026-04-16; v4.0.0 is ~2 days old at scaffold time). Silent minor/patch bumps could change hook lifecycle semantics or tool method names before the upstream API is settled.

| Package                           | Pinned version | Source                                                                                                                         | Verified                        |
| --------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| `@hashgraph/hedera-agent-kit`     | `4.0.0`        | [GitHub](https://github.com/hashgraph/hedera-agent-kit-js)                                                                     | 2026-04-19 (H-MCP-Buddy, PR #2) |
| `@hashgraph/hedera-agent-kit-mcp` | `1.0.0`        | Same monorepo, `packages/mcp` (separate version line from the main kit — note `1.0.0`, not `4.0.0`)                            | 2026-04-19 (H-MCP-Buddy, PR #2) |
| `@hiero-ledger/sdk`               | `2.81.0`       | Successor to `@hashgraph/sdk`. Version line stayed in 2.x through the rename; `hedera-agent-kit@4.0.0` declares peer `^2.81.0` | 2026-04-19 (H-MCP-Buddy, PR #2) |
| `@modelcontextprotocol/sdk`       | `1.29.0`       | Pinned to match `hedera-agent-kit-mcp@1.0.0`'s own dep to avoid double-install                                                 | 2026-04-19 (H-MCP-Buddy, PR #2) |
| `zod`                             | `3.25.76`      | Pinned to match `hedera-agent-kit-mcp@1.0.0`'s own dep                                                                         | 2026-04-19 (H-MCP-Buddy, PR #2) |
| `uuid`                            | `10.0.0`       | Generic — used by `auditEnvelopeBuilder` for `event_id`                                                                        | 2026-04-19 (H-MCP-Buddy, PR #2) |

> **Version sync with upstream:** `@hashgraph/hedera-agent-kit-mcp@1.0.0` bundles `@modelcontextprotocol/sdk@1.29.0` + `zod@3.25.76` as direct deps. We pin to the same versions to keep the install tree deduplicated. When we bump `hedera-agent-kit-mcp`, re-check its transitive deps and align.

## Upstream features this server depends on

Each row below names a specific feature of upstream we build on. If upstream changes the name, signature, or contract, we coordinate before bumping.

### From `@hashgraph/hedera-agent-kit` (core)

| Feature                                                                          | File / Export                                                       | What we use it for                                                                     |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `BaseTool` abstract class + 7-stage lifecycle                                    | `packages/core/src/shared/tools.ts`                                 | Our hooks plug into `postParamsNormalizationHook` and `postCoreActionHook` stages      |
| `Tool` type (`{ method, name, description, parameters, execute, outputParser }`) | Same                                                                | Interface our plugin's policy + hooks conform to                                       |
| `HederaBuilder.transferHbarWithAllowance`                                        | `core-account-plugin/tools/account/transfer-hbar-with-allowance.ts` | Core payment + refund primitive                                                        |
| `HederaBuilder.approveHbarAllowance`                                             | `core-account-plugin/tools/account/approve-hbar-allowance.ts`       | User-signed allowance grant (`RETURN_BYTES` mode)                                      |
| `HederaBuilder.transferHbar`                                                     | `core-account-plugin/tools/account/transfer-hbar.ts`                | Direct transfer (ops flows, not user payments)                                         |
| `create_topic` tool                                                              | `core-consensus-plugin/tools/topic/*`                               | One-time topic creation via bootstrap script                                           |
| `submit_message` tool                                                            | Same                                                                | Driven by AgentService outbox worker for audit submission                              |
| `tx-mode-strategy.ts` (`handleTransaction`)                                      | `packages/core/src/shared/strategies/tx-mode-strategy.ts`           | Mode switch AUTONOMOUS vs RETURN_BYTES, returns `{ bytes }` or `{ raw, humanMessage }` |
| `AgentMode.AUTONOMOUS` / `AgentMode.RETURN_BYTES`                                | Core types                                                          | Context flag per tool call                                                             |

### From `@hashgraph/hedera-agent-kit-mcp` (MCP wrapper)

| Feature                                            | File / Export               | What we use it for                                                           |
| -------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------- |
| `HederaMCPToolkit` class (extends MCP `McpServer`) | `packages/mcp/src/index.ts` | Our server is configured via this; registers every tool from our plugin list |
| Stdio transport                                    | `packages/mcp/src/stdio.ts` | Default transport; AgentService spawns as child                              |
| StreamableHTTP transport                           | `packages/mcp/src/http.ts`  | Dev-only debug transport; loopback-only                                      |

### From `@hiero-ledger/sdk`

| Feature                                       | What we use it for                                                          |
| --------------------------------------------- | --------------------------------------------------------------------------- |
| `Client` (operator/agent client factories)    | Two Client instances — one per role — injected via `accountResolver` policy |
| `TransferTransaction.addApprovedHbarTransfer` | Spending via pre-approved allowance                                         |
| `AccountAllowanceApproveTransaction`          | Underlying mechanism for approve_hbar_allowance tool                        |
| `TopicCreateTransaction`                      | Bootstrap script (M3)                                                       |
| `TopicId`, `AccountId`, `Hbar` types          | Typed primitives throughout                                                 |

## Subscription to upstream changes

**Required:** one buddy on the team subscribes to `hashgraph/hedera-agent-kit-js` GitHub releases. New minor / major releases trigger a review of this doc + the ESM of our plugin code before bumping.

**Convention:** when upstream ships a change that affects anything above:

1. Create a `docs/UPGRADE_NOTES_v<x.y.z>.md` file capturing what changed, what we need to update, migration steps.
2. Land the upgrade as its own PR (not mixed with feature work).
3. Update this file's pin row with the new version + initial of the buddy who verified.

## If upstream is unresponsive

We have a known-good v4.0.0. If upstream goes quiet and we hit a critical bug:

1. Fork `hedera-agent-kit-js` to `xeni-app/hedera-agent-kit-js-fork`.
2. Point our `package.json` at the fork via git URL.
3. Minimal patch set; upstream contribute later.
4. Revert to upstream once they respond.

Never lock ourselves into a fork for convenience — only under real blockage.

## Known ecosystem issues

Real upstream peer-range bugs we're currently masking with install-time workarounds. Each entry tracks a workaround that should be removed once upstream fixes the underlying issue.

### protobufjs peer-range mismatch

**What:** `@hiero-ledger/sdk@2.81.0` bundles `protobufjs@8.0.0`, but its transitive dep `@hiero-ledger/proto@2.26.0-beta.3` declares a strict peer of `protobufjs@"7.5.4"` (exact, not caret-range). npm v7+ `npm ci` with default `strict-peer-deps` rejects this.

**Workaround:** `.npmrc` in the repo root sets `legacy-peer-deps=true`, applied to both `npm install` and `npm ci`. Install tree deduplicates to ~423 packages; tests + coverage green.

**First observed:** 2026-04-19 (H-MCP-Buddy, PR #2 CI failure).
**Relevant upstream:** `@hiero-ledger/sdk` + `@hiero-ledger/proto` — file issue with Hiero once we confirm it's still present in their latest release line.

**Re-verification checklist** (run on every upstream bump of `@hiero-ledger/*` or `@hashgraph/hedera-agent-kit*`):

- [ ] Temporarily rename `.npmrc` → `.npmrc.disabled`.
- [ ] `rm -rf node_modules package-lock.json`
- [ ] `npm install` (no flags).
- [ ] If clean (no `ERESOLVE` or peer-dep errors): delete `.npmrc.disabled` entirely, commit the removal + regenerated lockfile, add an entry to the verification log below.
- [ ] If still broken: restore `.npmrc` (rename back), regenerate lockfile, add an entry to the verification log noting the still-broken upstream versions.

**Verification log:**

| Date       | Verifier    | Upstream versions                                                                                        | Still needed? | Notes                                                                     |
| ---------- | ----------- | -------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------- |
| 2026-04-19 | H-MCP-Buddy | `@hashgraph/hedera-agent-kit@4.0.0`, `@hashgraph/hedera-agent-kit-mcp@1.0.0`, `@hiero-ledger/sdk@2.81.0` | Yes           | Initial discovery. PR #2 CI broke without `.npmrc`; restored + committed. |
