# Design Dependencies

Upstream features this server relies on. Breaking changes in any of these require coordinated review before we version-bump.

## Exact-pin policy

Per Lead Buddy review item 2: these three packages are **pinned to exact versions** (no `^` or `~`) in `package.json`. Renovate / Dependabot are excluded from auto-bumping them (see `renovate` block in `package.json`).

Why: `hedera-agent-kit-js` v4 is bleeding edge (released 2026-04-16; v4.0.0 is ~2 days old at scaffold time). Silent minor/patch bumps could change hook lifecycle semantics or tool method names before the upstream API is settled.

| Package | Pinned version | Source |
|---|---|---|
| `@hashgraph/hedera-agent-kit` | `4.0.0` | [GitHub](https://github.com/hashgraph/hedera-agent-kit-js) |
| `@hashgraph/hedera-agent-kit-mcp` | `4.0.0` | Same monorepo, `packages/mcp` |
| `@hiero-ledger/sdk` | `4.0.0` | Hedera SDK v4 (renamed from `@hashgraph/sdk`) |

> **Pre-install verification:** the exact npm versions may differ slightly from the scaffold-time values above. Before first `npm install`, verify the latest published `4.0.x` on npmjs.com and update the pin accordingly. Record the verified version here, initialed by the buddy who verified.

## Upstream features this server depends on

Each row below names a specific feature of upstream we build on. If upstream changes the name, signature, or contract, we coordinate before bumping.

### From `@hashgraph/hedera-agent-kit` (core)

| Feature | File / Export | What we use it for |
|---|---|---|
| `BaseTool` abstract class + 7-stage lifecycle | `packages/core/src/shared/tools.ts` | Our hooks plug into `postParamsNormalizationHook` and `postCoreActionHook` stages |
| `Tool` type (`{ method, name, description, parameters, execute, outputParser }`) | Same | Interface our plugin's policy + hooks conform to |
| `HederaBuilder.transferHbarWithAllowance` | `core-account-plugin/tools/account/transfer-hbar-with-allowance.ts` | Core payment + refund primitive |
| `HederaBuilder.approveHbarAllowance` | `core-account-plugin/tools/account/approve-hbar-allowance.ts` | User-signed allowance grant (`RETURN_BYTES` mode) |
| `HederaBuilder.transferHbar` | `core-account-plugin/tools/account/transfer-hbar.ts` | Direct transfer (ops flows, not user payments) |
| `create_topic` tool | `core-consensus-plugin/tools/topic/*` | One-time topic creation via bootstrap script |
| `submit_message` tool | Same | Driven by AgentService outbox worker for audit submission |
| `tx-mode-strategy.ts` (`handleTransaction`) | `packages/core/src/shared/strategies/tx-mode-strategy.ts` | Mode switch AUTONOMOUS vs RETURN_BYTES, returns `{ bytes }` or `{ raw, humanMessage }` |
| `AgentMode.AUTONOMOUS` / `AgentMode.RETURN_BYTES` | Core types | Context flag per tool call |

### From `@hashgraph/hedera-agent-kit-mcp` (MCP wrapper)

| Feature | File / Export | What we use it for |
|---|---|---|
| `HederaMCPToolkit` class (extends MCP `McpServer`) | `packages/mcp/src/index.ts` | Our server is configured via this; registers every tool from our plugin list |
| Stdio transport | `packages/mcp/src/stdio.ts` | Default transport; AgentService spawns as child |
| StreamableHTTP transport | `packages/mcp/src/http.ts` | Dev-only debug transport; loopback-only |

### From `@hiero-ledger/sdk`

| Feature | What we use it for |
|---|---|
| `Client` (operator/agent client factories) | Two Client instances — one per role — injected via `accountResolver` policy |
| `TransferTransaction.addApprovedHbarTransfer` | Spending via pre-approved allowance |
| `AccountAllowanceApproveTransaction` | Underlying mechanism for approve_hbar_allowance tool |
| `TopicCreateTransaction` | Bootstrap script (M3) |
| `TopicId`, `AccountId`, `Hbar` types | Typed primitives throughout |

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
