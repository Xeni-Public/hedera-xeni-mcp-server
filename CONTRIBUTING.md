<!-- Authored-by: Anand Palanisamy - anand@xeni.com -->

# Contributing to `hedera-xeni-mcp-server`

Thanks for your interest. This repo is the Hedera payment + audit MCP server that powers Xeni's autonomous travel booking agent. A few guidelines to keep contributions landing smoothly.

## Ground rules

- **Read [docs/DESIGN.md](docs/DESIGN.md) first.** It covers the account model, money flow, audit durability, testing strategy, and migration conventions. PRs that conflict with documented invariants will be asked to either update the design doc first or reconsider the approach.
- **One concern per PR.** Don't mix unrelated fixes. A scaffold cleanup + a new hook + a doc change is three PRs.
- **Tests come with the code.** Every new hook / policy / utility ships with unit tests. Bug fixes ship with a regression test that would have caught the bug.
- **Follow the `TODO(pN):` convention.** If your PR closes a scaffold-TODO item (P1–P5 or a future numbered item), grep for it first to find all locations to update.

## Development setup

```bash
# Prereq: Node >= 20
npm install
cp .env.example .env.dev
$EDITOR .env.dev           # fill in your testnet accounts

npm run build
npm run test:unit          # required on every PR
npm run test:integration   # required on every PR
npm run test:e2e           # nightly on testnet-ci; run locally before prod-touching PRs
```

## Commit messages

- **Short imperative subject line** under 72 chars: `Add spendPolicyGuard hook`, not `Added spendPolicyGuard hook`.
- **Body explains why, not what.** The diff shows what.
- **Co-author attribution:** `Authored-By: Anand Palanisamy <anand@xeni.com>`. **Do not add** a `Co-Authored-By: Claude <noreply@anthropic.com>` line or a "Generated with Claude Code" footer.

Example:

```
Add spendPolicyGuard hook for approve_hbar_allowance

Rejects allowance requests that exceed the user's configured ceiling.
Pure policy check, no side effects. Ceiling is delivered via tool context
metadata from AgentService.

Covers DESIGN.md §6. Hook #1 of 4.

Authored-By: Anand Palanisamy <anand@xeni.com>
```

## PR checklist

Before requesting review:

- [ ] Lint passes (`npm run lint`)
- [ ] Format check passes (`npm run format:check`)
- [ ] Unit tests pass (`npm run test:unit`)
- [ ] Integration tests pass (`npm run test:integration`)
- [ ] Coverage on new hooks / policies ≥ 80% statements (§14 gate)
- [ ] **If this PR adds tests for previously-untested files**, updated `vitest.config.ts` `coverage.include` to add those file paths. The 80% gate is maintained by narrowing scope to files under test, not by lowering thresholds — see the comment above `coverage.include` in `vitest.config.ts`.
- [ ] No unresolved `TODO(pN):` comments that your PR was supposed to close
- [ ] Design doc updated if invariants, schema, or account model changed
- [ ] New files include the `Authored-by: Anand Palanisamy - anand@xeni.com` header at the top (see existing files for per-type comment syntax)
- [ ] No secrets, `.env` files, or private keys in the diff

For PRs that touch on-chain behavior (transfers, allowances, topics): also confirm testnet E2E green before merge.

## Security issues

Don't file public issues for security vulnerabilities. See [SECURITY.md](SECURITY.md) for the disclosure process.

## Upstream dependencies

Three packages are pinned to exact versions (see [docs/DESIGN_DEPENDENCIES.md](docs/DESIGN_DEPENDENCIES.md)). Renovate is configured to leave them alone:

- `@hashgraph/hedera-agent-kit`
- `@hashgraph/hedera-agent-kit-mcp`
- `@hiero-ledger/sdk`

Bumping any of these requires a dedicated PR with upgrade notes (see `docs/DESIGN_DEPENDENCIES.md`).

## Migrations

DB schema changes and on-chain bootstrap operations are **standalone deploy steps** — never auto-run on server startup. See `docs/DESIGN.md` §15.

If your PR introduces a schema change:
1. Write + test a standalone migration script under `scripts/migrations/` (or the appropriate path).
2. Coordinate the run ordering with Anand (who runs all migrations).
3. Reference the migration action item in your PR description.

## Scope for v1

In scope: HBAR payments, HCS audit via outbox, Xeni-MoR.

Out of scope (don't open PRs for these unless flagged first):
- HTS / USDC / stablecoins (Phase 2)
- HCS-listener-triggered booking (Phase 3)
- Customer-MoR flows (Phase 5)
- NFT tooling, scheduled transactions, LangChain integration

## License

By contributing, you agree your contributions will be licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).
