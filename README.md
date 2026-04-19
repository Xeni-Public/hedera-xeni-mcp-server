<!-- Authored-by: Anand Palanisamy - anand@xeni.com -->

# hedera-xeni-mcp-server

MCP (Model Context Protocol) server exposing Hedera HBAR payment + HCS audit tools with Xeni intent-mandate semantics. Built on top of [`@hashgraph/hedera-agent-kit`](https://github.com/hashgraph/hedera-agent-kit-js) v4.

**Status:** v0.1.0 scaffold. Structure + docs only. Implementation lands in subsequent PRs.

**Visibility:** internal-only (`xeni-app`) for v1. Public release to `Xeni-Public/hedera-xeni-mcp-server` is deferred until v1 is proven working. License is already Apache-2.0 on the internal repo so the eventual public push is a remote add, not a license change.

> **Naming note:** this repo is named `hedera-xeni-mcp-server` with `hedera` first (diverging from the usual `xeni-*` prefix used by other internal repos like `xeni-mcp-server`). Rationale: this server is built on top of the Hedera blockchain primitives (via `hedera-agent-kit-js`) rather than being a Xeni-internal service. The `xeni-*` naming convention is preserved for the companion repo [`xeni-mcp-server`](https://github.com/Xeni-Public/xeni-mcp-server) (travel booking tools). See design review item 14.

## What this server does

In one sentence: lets the AI travel agent spend HBAR from a user's wallet (within a pre-granted allowance) and log the resulting audit trail to a Hedera Consensus Service (HCS) topic — without the server ever holding the user's private key.

Concretely, v1 exposes:

| Upstream tool (from `hedera-agent-kit`) | Used for |
|---|---|
| `approve_hbar_allowance` | User A grants a spending allowance to the Xeni agent account (user-signed via wallet, `AgentMode.RETURN_BYTES`) |
| `transfer_hbar_with_allowance` | Agent spends within the allowance to pay `xeni_treasury` (booking) or refund User A (treasury→agent refund allowance) |
| `transfer_hbar` | Direct transfer (used for ops flows, not user payments) |
| `submit_message` | HCS audit event submission (driven by AgentService's outbox worker, not by this server) |
| `create_topic` | One-time global `xeni_audit` topic creation per environment (via `scripts/bootstrap-audit-topic.ts`, not a server tool) |

Our custom layer on top is **4 hooks + 1 policy** — no new tools. See [docs/DESIGN.md](docs/DESIGN.md) for the full picture.

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

| Env | Network | Config file |
|---|---|---|
| `dev` | Hedera testnet | `.env.dev` |
| `testnet-ci` | Hedera testnet (CI) | CI secrets |
| `testnet-uat` | Hedera testnet (UAT) | `.env.testnet-uat` |
| `mainnet-prod` | Hedera mainnet | Prod secrets manager |

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
