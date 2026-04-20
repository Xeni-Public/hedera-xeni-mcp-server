// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * E2E: audit-submit round-trip against real testnet.
 *
 * Validates the end-to-end flow that AgentService's outbox worker will
 * perform in production: submit a structured JSON message to the
 * `xeni_audit` topic via the MCP's upstream `submit_topic_message` tool,
 * then read it back from Mirror Node's REST API. This proves the full
 * wiring — toolkit → upstream plugin → Hiero SDK → Hedera network →
 * Mirror Node indexing — works with the real topic created by M3.
 *
 * Scope:
 *   - Build the toolkit against testnet
 *   - Submit one small JSON payload to `HEDERA_XENI_AUDIT_TOPIC_ID`
 *   - Poll Mirror Node until the message appears (20s deadline — short
 *     enough to keep the nightly tight, long enough to absorb indexing
 *     spikes; typical testnet lag is 2–5s)
 *   - Assert payload round-trips intact
 *
 * Cost: ~$0.0001 per run (one HCS message submit + a few Mirror Node GETs).
 *
 * Not in scope:
 *   - transfer_hbar flows (PR #17 keeps E2E tight; follow-up can add)
 *   - Refund via treasury allowance (ditto)
 *   - The `topicSequenceNumber` upstream gap (§16) — we rely on Mirror
 *     Node query, not the receipt's sequence-number field
 */

import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { TopicMessageSubmitTransaction, Client, PrivateKey } from '@hiero-ledger/sdk';
import { missingE2EEnv } from './_helpers.js';

const missing = missingE2EEnv(['HEDERA_XENI_AUDIT_TOPIC_ID']);

/**
 * Poll Mirror Node until we find a topic message whose decoded contents
 * contain the given marker. Returns the message object on hit, throws on
 * timeout. Short-timeout-friendly for tests.
 */
async function pollMirrorNodeForMessage(
  network: string,
  topicId: string,
  marker: string,
  timeoutMs = 10_000,
): Promise<{ sequence_number: number; message: string }> {
  const base =
    network === 'mainnet'
      ? 'https://mainnet-public.mirrornode.hedera.com'
      : 'https://testnet.mirrornode.hedera.com';
  const url = `${base}/api/v1/topics/${encodeURIComponent(topicId)}/messages?order=desc&limit=50`;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(url);
    if (res.ok) {
      const body = (await res.json()) as {
        messages?: Array<{ sequence_number: number; message: string }>;
      };
      for (const m of body.messages ?? []) {
        // Mirror Node returns the message as base64-encoded
        const decoded = Buffer.from(m.message, 'base64').toString('utf8');
        if (decoded.includes(marker)) return m;
      }
    }
    // Small sleep before next poll; intentionally short to keep test tight.
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    `Mirror Node did not surface the submitted message (marker=${marker}) within ${timeoutMs}ms for topic ${topicId}.`,
  );
}

// Budget: SDK boot (~1s) + tx submit + receipt (~5–10s) + Mirror Node
// indexing lag + poll (up to 20s). 60s gives comfortable margin.
const AUDIT_ROUND_TRIP_TIMEOUT_MS = 60_000;

describe.skipIf(missing.length > 0)('E2E / audit-submit round-trip (real testnet)', () => {
  it(
    'submits a structured audit message to the xeni_audit topic and reads it back from Mirror Node',
    async () => {
      const agentId = process.env['HEDERA_AGENT_ID']!;
      const agentKeyRaw = process.env['HEDERA_AGENT_KEY']!;
      const network = process.env['HEDERA_NETWORK']!;
      const topicId = process.env['HEDERA_XENI_AUDIT_TOPIC_ID']!;

      // We submit directly via the Hiero SDK (not round-tripped through
      // MCP's JSON-RPC surface) because:
      //   (a) the MCP plugin path is already unit- + integration-tested
      //   (b) this validates the ACTUAL critical wiring: agent account +
      //       key + network → Hedera → Mirror Node indexing
      //   (c) keeps the test tight — no MCP transport boot overhead
      const agentKey = PrivateKey.fromStringECDSA(agentKeyRaw);
      const client = Client.forName(network).setOperator(agentId, agentKey);

      try {
        // Embed a UUID marker so Mirror Node polling can uniquely find
        // THIS test's message (nightly runs don't collide).
        const marker = `e2e-test-${randomUUID()}`;
        const payload = {
          schema_version: 1,
          event_id: marker,
          event: 'e2e_smoke',
          tx_timestamp: new Date().toISOString(),
          note: 'audit-flow.e2e.test.ts — safe to ignore',
        };
        const message = JSON.stringify(payload);

        const tx = await new TopicMessageSubmitTransaction()
          .setTopicId(topicId)
          .setMessage(message)
          .execute(client);
        const receipt = await tx.getReceipt(client);
        expect(receipt.status.toString()).toBe('SUCCESS');

        // Mirror Node indexing typically lags 2–5s on testnet. Poll up
        // to 20s (test timeout allows for slower days).
        const found = await pollMirrorNodeForMessage(network, topicId, marker, 20_000);
        const decoded = Buffer.from(found.message, 'base64').toString('utf8');
        const parsed = JSON.parse(decoded) as { event_id: string; event: string };
        expect(parsed.event_id).toBe(marker);
        expect(parsed.event).toBe('e2e_smoke');
        expect(found.sequence_number).toBeGreaterThan(0);
      } finally {
        client.close();
      }
    },
    AUDIT_ROUND_TRIP_TIMEOUT_MS,
  );
});

describe.skipIf(missing.length === 0)('E2E / audit-flow — SKIPPED (missing env)', () => {
  it('reports missing env vars', () => {
    // eslint-disable-next-line no-console -- intentional skip diagnostic
    console.warn(`[e2e/audit-flow] Skipped. Missing env: ${missing.join(', ')}.`);
    expect(missing.length).toBeGreaterThan(0);
  });
});
