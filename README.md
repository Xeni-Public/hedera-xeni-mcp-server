<!-- Authored-by: Anand Palanisamy - anand@xeni.com -->

# hedera-xeni-mcp-server

MCP (Model Context Protocol) server exposing Hedera HBAR payment + HCS audit tools with Xeni intent-mandate semantics. Built on top of [`@hashgraph/hedera-agent-kit`](https://github.com/hashgraph/hedera-agent-kit-js) v4.

**Status:** v0.1.0 scaffold. Structure + docs only. Implementation lands in subsequent PRs.

**Visibility:** internal-only (`xeni-app`) for v1. Public release to `Xeni-Public/hedera-xeni-mcp-server` is deferred until v1 is proven working. License is already Apache-2.0 on the internal repo so the eventual public push is a remote add, not a license change.

> **Naming note:** this repo is named `hedera-xeni-mcp-server` with `hedera` first (diverging from the usual `xeni-*` prefix used by other internal repos like `xeni-mcp-server`). Rationale: this server is built on top of the Hedera blockchain primitives (via `hedera-agent-kit-js`) rather than being a Xeni-internal service. The `xeni-*` naming convention is preserved for the companion repo [`xeni-mcp-server`](https://github.com/Xeni-Public/xeni-mcp-server) (travel booking tools). See design review item 14.

## What this server does

In one sentence: lets the AI travel agent spend HBAR from a user's wallet (within a pre-granted allowance) and log the resulting audit trail to a Hedera Consensus Service (HCS) topic — without the server ever holding the user's private key.

Concretely, v1 exposes:

| Upstream tool (from `hedera-agent-kit`) | Used for                                                                                                                |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `approve_hbar_allowance`                | User A grants a spending allowance to the Xeni agent account (user-signed via wallet, `AgentMode.RETURN_BYTES`)         |
| `transfer_hbar_with_allowance`          | Agent spends within the allowance to pay `xeni_treasury` (booking) or refund User A (treasury→agent refund allowance)   |
| `transfer_hbar`                         | Direct transfer (used for ops flows, not user payments)                                                                 |
| `submit_message`                        | HCS audit event submission (driven by AgentService's outbox worker, not by this server)                                 |
| `create_topic`                          | One-time global `xeni_audit` topic creation per environment (via `scripts/bootstrap-audit-topic.ts`, not a server tool) |

There is **no custom Xeni layer on top of these tools** in the MCP. Upstream tools are exposed as-is via `HederaMCPToolkit`. All Xeni-specific business logic (spend-policy ceiling check, mandate-budget check, treasury-allowance check + Slack alerts, audit envelope building) lives in **AgentService** (Go). See the Architecture section below for why, and [docs/HANDOVER_TO_AGENT_SERVICE.md](docs/HANDOVER_TO_AGENT_SERVICE.md) for the Go-port specs.

## Architecture: why guards live in AgentService, not in the MCP

The original plan was a plugin in this MCP that wrapped upstream tools with Xeni-specific hooks (spend ceiling, mandate budget, treasury allowance + Slack alerts, audit envelope builder). After verifying upstream `@hashgraph/hedera-agent-kit-mcp@1.0.0`, two constraints made that MCP-side design impractical, and we pivoted to a thinner MCP with the guards on the AgentService side.

### What we leverage from upstream hedera-agent-kit-js

We stay on the happy path and touch nothing upstream (no forks, no patches, no runtime monkey-patching — only config files consume upstream):

| Upstream surface                                                                               | How we use it                                                                                                                                                |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `HederaMCPToolkit` (`@hashgraph/hedera-agent-kit-mcp`)                                         | Construct once with `{ client, configuration }` — it registers every upstream tool as an MCP method for us                                                   |
| Core account tools (`approve_hbar_allowance`, `transfer_hbar_with_allowance`, `transfer_hbar`) | Exposed via the toolkit unchanged; no wrappers                                                                                                               |
| Core consensus tools (`submit_message`)                                                        | Exposed via the toolkit; AgentService's outbox worker calls it                                                                                               |
| `Client` from `@hiero-ledger/sdk`                                                              | One instance, constructed at startup from agent env vars, injected into the toolkit                                                                          |
| `AgentMode.AUTONOMOUS` / `AgentMode.RETURN_BYTES`                                              | Mode context flag — AgentService chooses per call (RETURN_BYTES for user allowance grants signed in wallet; AUTONOMOUS for everything else the server signs) |
| stdio + StreamableHTTP transports (`@modelcontextprotocol/sdk`)                                | Bind the toolkit to a transport — AgentService spawns us via stdio; http is dev-loopback only                                                                |
| `TopicCreateTransaction`, `AccountCreateTransaction`, `AccountAllowanceApproveTransaction`     | Used directly in `scripts/bootstrap-*.ts` for one-time M3/M4 bootstrap; not at runtime                                                                       |

**Upstream is untouched.** Our repo pins exact versions (see [docs/DESIGN_DEPENDENCIES.md](docs/DESIGN_DEPENDENCIES.md)) and imports from published packages — no forks, no patches, no subclasses that override upstream behavior. Only Xeni repo files (`.env`, `.npmrc`, `package.json`, our own `src/`) are our creations.

### Pros of moving guards to AgentService

| Pro                                      | Details                                                                                                                                                                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Upstream untouched**                   | No forks of `@hashgraph/hedera-agent-kit-mcp`; we stay on released versions. Upgrades follow upstream's own cadence.                                                                                                                 |
| **MCP stays thin**                       | ~150 lines of wiring (toolkit + transports + config + logger) vs. ~1000+ lines of guards + hooks + plugin infrastructure. Smaller surface to review, test, maintain, upgrade.                                                        |
| **Single signing identity**              | Matches upstream's `HederaMCPToolkit` which takes one `Client`. Agent is the only key in the server process — operator + treasury stay cold (bootstrap + ops only). Smaller attack surface.                                          |
| **Fail-fast guards**                     | AgentService rejects policy-violating calls before a round-trip to MCP. Faster user-visible feedback.                                                                                                                                |
| **Single place for Xeni business logic** | Policy, mandate, treasury allowance, audit envelope, fee calculation all live in Go in one repo next to the intent state they reference. No TS↔Go drift risk.                                                                       |
| **No metadata-threading hack**           | Upstream `@hashgraph/hedera-agent-kit-mcp` doesn't forward `_meta` from MCP requests into tool execution (it drops `_extra` before calling `_hederaAgentKit.run`). No need for Xeni-branded wrapper tools with extended zod schemas. |
| **Simpler test story**                   | MCP CI validates wiring, not business logic. AgentService's Go tests own the policy invariants. Porting guards from TS specs to Go ports is a known pattern.                                                                         |
| **Easier to swap MCP out**               | If upstream ever ships a deployable MCP binary directly, we could drop this repo entirely and point AgentService at theirs. No Xeni code to migrate.                                                                                 |

### Cons / tradeoffs

| Con                                                    | Mitigation                                                                                                                                               |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AgentService Buddy has more Go work**                | TS reference implementations + 68 tests live in `reference-impl/` as behavioral specs to port against. Handover doc walks through each guard's contract. |
| **Lose single-language Xeni policy story**             | Was never quite true — `accountResolver` was TS-only, but all callers were already Go. Now it's uniformly Go.                                            |
| **TS reference code is technically unused at runtime** | Kept in `reference-impl/` and still executed by `vitest` so the specs stay live. Tests serve as executable documentation of expected guard behavior.     |
| **Design doc §6 ("custom Xeni layer") is reduced**     | Rewritten to reflect current state — no MCP-side plugin, no AbstractHook wrappers, no custom tools.                                                      |
| **No hook-based observability inside MCP**             | Consequence, not really a loss — AgentService logs every guard decision with full intent context; the MCP doesn't need to duplicate.                     |
| **Marginal extra DB round-trip**                       | AgentService has to read mandate state for mandate-budget guard anyway — minimal extra cost.                                                             |

### What stayed in the original design

The pivot is scoped to guard placement. Everything else holds:

- **Single global `xeni_audit` HCS topic per environment** (design §5)
- **Rolling daily refund cap, Slack alert at 80% consumed, manual nightly top-up** (design §4) — still the ops story; just implemented in Go now
- **Outbox pattern for audit durability** (design §13) — unchanged
- **Migrations are standalone deploy steps, Anand runs** (design §15) — unchanged
- **UTC persistence + PST for ops readability + cap cutover** (design §4 tz rules) — unchanged
- **Per-env account + topic isolation** (design §3 + §5) — unchanged
- **Public/private boundary for fee logic** — now AgentService-side instead of MCP-side

See [docs/DESIGN.md](docs/DESIGN.md) for the full updated architecture; [docs/HANDOVER_TO_AGENT_SERVICE.md](docs/HANDOVER_TO_AGENT_SERVICE.md) for the AgentService-side work breakdown.

## How this server fits in the system

```
ai-agent-web (Claude + MCP directly — no LangChain)
    ↓
AgentService (ai-agent-api-service, Go; built on Falcon framework)
  │  │  │
  │  │  └──► hedera-xeni-mcp-server  (this repo — money + audit tools)
  │  └─────► xeni-mcp-server          (travel booking tools, separate repo)
  │
  └──► audit outbox table (postgres) ──► outbox worker ──► hedera-xeni-mcp-server.submit_message ──► global xeni_audit topic
```

AgentService owns the intent state machine and orchestrates money-tool calls synchronously (`pay → book`). HCS audit submission is async via an outbox pattern in AgentService's DB — see [docs/DESIGN.md §13](docs/DESIGN.md).

## Quickstart (dev)

```bash
# Prereqs: Node >= 20

# 1. Install deps (exact versions pinned — see docs/DESIGN_DEPENDENCIES.md)
npm install

# 2. Copy env config and fill in your testnet accounts
cp .env.example .env.dev
$EDITOR .env.dev   # fill in operator, agent, treasury ids + keys

# 3. (Once per env) Bootstrap on-chain state — Anand runs these at cutover; in dev you run locally
npm run bootstrap:audit-topic        # creates global xeni_audit HCS topic (M3)
npm run bootstrap:treasury           # creates dedicated treasury + refund allowance (M4)

# 4. Build + run
npm run build
npm run start:stdio                  # default — spawned by AgentService as a child
# or
npm run start:http                   # dev debug only; binds 127.0.0.1 (loopback)

# 5. Test
npm run test:unit                    # unit — required on every PR
npm run test:integration             # integration — required on every PR
npm run test:e2e                     # E2E on testnet — nightly, not per-PR
```

## Environments

Per-env account + topic isolation. No shared accounts across envs.

| Env            | Network              | Config file          |
| -------------- | -------------------- | -------------------- |
| `dev`          | Hedera testnet       | `.env.dev`           |
| `testnet-ci`   | Hedera testnet (CI)  | CI secrets           |
| `testnet-uat`  | Hedera testnet (UAT) | `.env.testnet-uat`   |
| `mainnet-prod` | Hedera mainnet       | Prod secrets manager |

## Documentation

- **[docs/DESIGN.md](docs/DESIGN.md)** — v1 architecture, account model, money flow, audit durability, migration & cutover, testing strategy
- **[docs/DESIGN_DEPENDENCIES.md](docs/DESIGN_DEPENDENCIES.md)** — upstream features we rely on + version-pinning rationale
- **[docs/RUNBOOKS.md](docs/RUNBOOKS.md)** — ops procedures: treasury replenishment, cap-hit UX, dead-letter response, smoke test

## Coordination with other buddies

- `AgentService` owns orchestration, outbox, worker. See coordination log (internal).
- `Frontend` owns wallet integration for user allowance grants + HashScan URL handling.
- **Migrations** are standalone deploy steps owned by Anand — see internal memory note `feedback_migrations_standalone.md`.

## License

Apache-2.0. See [LICENSE](LICENSE).
