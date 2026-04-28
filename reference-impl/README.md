<!-- Authored-by: Anand Palanisamy - anand@xeni.com -->

# reference-impl/ — executable specifications for AgentService Go ports

This directory holds the TypeScript reference implementations of the guard hooks, audit envelope builder, shared tinybar math, and fee calculator that were originally planned inside the MCP (PRs #4, #5, #6). Following the 2026-04-20 Option D pivot (see [`../docs/DESIGN.md`](../docs/DESIGN.md) and [`../docs/HANDOVER_TO_AGENT_SERVICE.md`](../docs/HANDOVER_TO_AGENT_SERVICE.md)), the runtime implementations move to AgentService (Go). The TypeScript lives on here as **executable specifications**.

## What this directory is for

- **A behavioral contract** AgentService's Go port must match. Each guard + the envelope builder has a precise input/output contract, a precise set of reject conditions, and a test suite that demonstrates those conditions. The Go port is right when the equivalent Go test suite asserts the same behaviors.
- **CI-verified** — `npm run test:unit` runs these tests alongside any MCP unit tests. If someone changes a reference implementation's behavior, the spec change is caught immediately.
- **Not shipped** — excluded from `tsconfig.json` build (never compiled into the MCP binary) and excluded from the MCP's production code path. The MCP doesn't import these modules at runtime.

## What this directory is NOT

- **Not the Go port itself** — that lives in AgentService's repo.
- **Not called at runtime by the MCP** — the MCP exposes upstream tools as-is; it has no plugin, no hooks, no policies (see `../docs/DESIGN.md` §6).
- **Not a library to import** — don't `import from 'reference-impl/...'` in `src/` code. If you need the behavior, either port it to Go (AgentService) or build it as a proper TS module under `src/` with its own design review.

## Layout

```
reference-impl/
├── README.md                     (this file)
├── logger.ts                     (local copy of src/logger.ts so this dir is self-contained)
├── hbar.ts                       (shared tinybar math: toTinybar, fromTinybar, invalidNumberReason)
├── hooks/
│   ├── spendPolicyGuard.ts       (pre-approve_hbar_allowance ceiling check)
│   ├── mandateBudgetGuard.ts     (pre-transfer_hbar_with_allowance budget check)
│   ├── treasuryAllowanceGuard.ts (pre-refund check + ops alert + Mirror Node dep injection)
│   └── auditEnvelopeBuilder.ts   (post-receipt envelope shape)
├── policies/
│   └── accountResolver.ts        (RETIRED post-pivot — historical context only; do NOT port)
├── fees/
│   ├── FeeCalculator.ts          (interface)
│   └── DefaultFeeCalculator.ts   (reference impl: flat 10%)
└── tests/
    ├── hbar.test.ts
    ├── spendPolicyGuard.test.ts
    ├── mandateBudgetGuard.test.ts
    ├── treasuryAllowanceGuard.test.ts
    ├── auditEnvelopeBuilder.test.ts
    └── accountResolver.test.ts   (RETIRED; still runs to keep the retired spec green)
```

## Porting guide for AgentService

See [`../docs/HANDOVER_TO_AGENT_SERVICE.md`](../docs/HANDOVER_TO_AGENT_SERVICE.md) for the full per-concern port specs — inputs, decision rules, side effects, reject reasons, test-coverage targets, and the guard→envelope field mapping table.

Quick start:

1. Read `../docs/HANDOVER_TO_AGENT_SERVICE.md` top to bottom.
2. For each guard, read the corresponding `hooks/*.ts` file and its `tests/*.test.ts` sibling.
3. Implement the Go port. Name Go test cases the same as the TS tests (language-neutral names — "rejects NaN amount", not "rejects when Number.isFinite returns false").
4. Run the Go tests against the Go port. If Go behavior differs from what the TS spec asserts, the HANDOVER doc is the tiebreaker — open a coordination-log entry and align.

## Ownership + maintenance

Per HANDOVER §"HANDOVER as source of truth":

- Behavioral changes ship as HANDOVER edits first, via coordination log.
- Then land in BOTH `reference-impl/` (TS) and AgentService (Go).
- If the two drift, whichever lags the HANDOVER is the bug.

**This directory is NOT abandoned.** If AgentService finds a spec bug during Go porting (edge case the TS tests missed, unclear contract, etc.), open a coordination-log entry and the correction lands in both places.

## Why keep the TS if Go is the real implementation?

1. **Cross-language spec.** TS + vitest is executable documentation. A markdown doc describing the behavior can be misread; a test case asserting `expect(result.passed).toBe(false)` for a specific input cannot.
2. **Regression safety.** If someone ever reconsiders moving guards back into the MCP (unlikely but possible), the TS is already there — tested, documented, with git blame history from PRs #4, #5, #6.
3. **Team bandwidth hedge.** If AgentService Buddy is swamped and someone else needs to spec-check a guard's behavior, reading TS is faster than reading Go they didn't write.
4. **Upstream contract cross-check.** If we ever contribute an upstream PR to `hedera-agent-kit-js` (e.g., the `topicSequenceNumber` gap noted in HANDOVER), the TS reference gives us a place to validate the upstream change against our expected behavior before committing to the Go port.

## Retired components

| Module                        | Why retired                                                                       | Kept because                                                                                                                                                                         |
| ----------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `policies/accountResolver.ts` | Single-client MCP post-pivot doesn't need tool→role routing. No runtime consumer. | Historical design context for AgentService reviewers. Clearly marked RETIRED at the top of the file + test. Tests still run in CI to keep the module green; Go port is NOT expected. |

If more items retire in the future, follow the same pattern: `⚑ RETIRED` banner at the top of the file, `⚑ RETIRED` banner at the top of the test, entry in this table.
