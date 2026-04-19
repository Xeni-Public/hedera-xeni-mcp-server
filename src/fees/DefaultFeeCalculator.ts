// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * Reference fee calculator — PUBLIC, for dev + open-source reference.
 *
 * This implementation is deliberately simplistic (flat percentage split) to
 * document the FeeCalculator contract without exposing real Xeni fee logic.
 *
 * Production must load the private plugin (`hedera-xeni-mcp-fee-private`)
 * which overrides this impl. See docs/DESIGN.md §7.
 *
 * Fail-open behavior: in `NODE_ENV=development`, if the private plugin fails
 * to load, we fall back to this. In production, we fail-closed (server
 * refuses to start).
 */

import type { FeeCalculator, FeeCalculationContext, FeeBreakdown } from './FeeCalculator.js';

export class DefaultFeeCalculator implements FeeCalculator {
  readonly name = 'DefaultFeeCalculator';

  /** Flat 10% platform fee, flat 10% customer commission, 80% supplier cost. */
  calculate(context: FeeCalculationContext): FeeBreakdown {
    const total = context.amountHbar;
    const platformFee = round6(total * 0.1);
    const customerCommission = round6(total * 0.1);
    const supplierCost = round6(total - platformFee - customerCommission);
    return { supplierCost, platformFee, customerCommission };
  }
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
