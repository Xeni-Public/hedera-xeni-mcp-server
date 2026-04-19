/**
 * xeniIntentMandate plugin — exports the plugin registration for
 * HederaMCPToolkit. Zero net-new tools — just 4 hooks + 1 policy.
 *
 * See docs/DESIGN.md §6.
 */

export { spendPolicyGuard } from './hooks/spendPolicyGuard.js';
export { mandateBudgetGuard } from './hooks/mandateBudgetGuard.js';
export { treasuryAllowanceGuard } from './hooks/treasuryAllowanceGuard.js';
export { auditEnvelopeBuilder } from './hooks/auditEnvelopeBuilder.js';
export { resolveRole } from './policies/accountResolver.js';

// TODO: after first install, wire these into a hedera-agent-kit plugin
// object with the correct shape (`{ hooks: [...], policies: [...] }` etc.)
// per @hashgraph/hedera-agent-kit's plugin interface. Implementation PR.
export const xeniIntentMandatePlugin = {
  name: 'xeni-intent-mandate',
  // TODO: hooks + policies wiring
};
