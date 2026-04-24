// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * Pre-flight Mirror Node endpoint smoke-check (issue #22).
 *
 * Runs BEFORE the nightly E2E suite as a workflow gate. Hits each Mirror
 * Node endpoint we depend on and asserts HTTP 200 + response shape. Any
 * failure after 3 retries fails the workflow step, which short-circuits
 * the E2E step that follows — so we don't drown in cryptic downstream
 * errors when the real cause is "Mirror Node is broken / shape-shifted."
 *
 * Usage:
 *   npm run smoke:mirror-node
 *
 * Required env:
 *   HEDERA_NETWORK              — "testnet" | "mainnet"
 *   HEDERA_XENI_AUDIT_TOPIC_ID  — topic ID for endpoints #1 + #4
 *   HEDERA_AGENT_ID             — agent account for endpoints #2 + #3
 *   HEDERA_XENI_TREASURY_ID     — treasury account for endpoint #3
 *
 * Output contract: info lines to stderr (pass / summary / failures);
 * nothing on stdout; exit 0 on all-pass, exit 1 on any probe fail after
 * retries. Parallel to the M3/M4 bootstrap scripts' stderr convention.
 */

import { pathToFileURL } from 'node:url';
import {
  buildProbes,
  probeEndpoint,
  type EndpointProbe,
  type ProbeDeps,
  type ProbeResult,
} from './lib/mirrorSmoke.js';

/* v8 ignore start -- Trivial console-wrapping default; business logic uses the injected dep. */
function defaultLogStderr(message: string): void {
  // eslint-disable-next-line no-console -- scripts are allowed to log to stderr
  console.error(message);
}
/* v8 ignore stop */

export interface RunSmokeInput {
  probes: EndpointProbe[];
}

export interface RunSmokeDeps extends ProbeDeps {
  logStderr?: (message: string) => void;
}

export interface RunSmokeResult {
  passed: number;
  failed: number;
  failures: string[];
}

/**
 * Orchestrator: run every probe serially, collect failures, return a
 * summary. Pure wrt IO (all side-effects injected). Caller (`main`)
 * decides whether to exit non-zero.
 */
export async function runSmoke(
  input: RunSmokeInput,
  deps: RunSmokeDeps = {},
): Promise<RunSmokeResult> {
  const logStderr = deps.logStderr ?? defaultLogStderr;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  for (const probe of input.probes) {
    const result: ProbeResult = await probeEndpoint(probe, deps);
    if (result.ok) {
      passed++;
      logStderr(
        `[OK] ${probe.label} (${probe.classification}) — passed on attempt ${result.attempts}`,
      );
    } else {
      failed++;
      const msg = result.errorMessage ?? '(missing error message)';
      failures.push(msg);
      logStderr(msg);
    }
  }

  logStderr(
    `[SUMMARY] smoke probe: ${passed} passed, ${failed} failed out of ${input.probes.length}`,
  );
  return { passed, failed, failures };
}

/* v8 ignore start -- CLI env wiring; exercised via E2E / manual workflow_dispatch */
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`Required env var missing: ${name}.`);
  }
  return v.trim();
}

async function main(): Promise<void> {
  // HEDERA_NETWORK isn't needed by the probes directly — the smoke-check
  // URLs are fully resolved from HEDERA_MIRROR_NODE_URL (which already
  // encodes the network at the hostname level). Keeping the network read
  // out of this script means `npm run smoke:mirror-node` can run with the
  // minimum env surface: URL + three Hedera IDs.
  const mirrorNodeUrl = requireEnv('HEDERA_MIRROR_NODE_URL');

  const probes = buildProbes({
    mirrorNodeUrl,
    topicId: requireEnv('HEDERA_XENI_AUDIT_TOPIC_ID'),
    agentAccountId: requireEnv('HEDERA_AGENT_ID'),
    treasuryAccountId: requireEnv('HEDERA_XENI_TREASURY_ID'),
  });

  const result = await runSmoke(
    { probes },
    {
      logStderr: defaultLogStderr,
    },
  );

  if (result.failed > 0) process.exit(1);
}
/* v8 ignore stop */

/* v8 ignore start -- CLI entry point; invocation-scope */
const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  main().catch((err: unknown) => {
    defaultLogStderr(`[ERROR] smoke-mirror-node failed: ${String(err)}`);
    process.exit(1);
  });
}
/* v8 ignore stop */
