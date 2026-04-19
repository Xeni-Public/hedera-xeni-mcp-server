// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * accountResolver unit tests — covers the deterministic policy decisions per
 * DESIGN.md §6. Other hooks tested in their own files / skeleton stubs for now.
 */

import { describe, expect, it } from 'vitest';
import { resolveRole } from '../../src/plugins/xeniIntentMandate/policies/accountResolver.js';

// Minimal registry stub — resolver doesn't actually query it for v1 but
// the signature accepts one for future multi-customer routing (Phase 5).
const registry = {
  get: () => ({ role: 'operator' as const, accountId: '0.0.1' }),
  has: () => true,
};

describe('accountResolver', () => {
  it('routes create_topic to operator (HCS fees paid by operator)', () => {
    expect(resolveRole({ tool: 'create_topic' }, registry)).toBe('operator');
  });

  it('routes submit_message to operator', () => {
    expect(resolveRole({ tool: 'submit_message' }, registry)).toBe('operator');
  });

  it('routes approve_hbar_allowance to agent (RETURN_BYTES; server does not sign)', () => {
    expect(resolveRole({ tool: 'approve_hbar_allowance' }, registry)).toBe('agent');
  });

  it('routes transfer_hbar_with_allowance to agent (spends via approved allowance)', () => {
    expect(resolveRole({ tool: 'transfer_hbar_with_allowance' }, registry)).toBe('agent');
  });

  it('routes transfer_hbar to agent by default', () => {
    expect(resolveRole({ tool: 'transfer_hbar' }, registry)).toBe('agent');
  });

  it('respects overrideRole when provided (ops flows)', () => {
    expect(resolveRole({ tool: 'transfer_hbar', overrideRole: 'operator' }, registry)).toBe(
      'operator',
    );
  });
});
