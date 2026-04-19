// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * Fee calculator interface — public.
 *
 * The real platform-fee calculation is PROPRIETARY and lives in a separate
 * private plugin (`hedera-xeni-mcp-fee-private`). See docs/DESIGN.md §7
 * (Public/private boundary).
 *
 * This file defines only the interface. Implementations:
 *   - `DefaultFeeCalculator` (public, reference — e.g. flat 10%)
 *   - `platformFeeCalculator` (PRIVATE — real Xeni fee logic; loaded via
 *     HEDERA_XENI_PRIVATE_PLUGINS in UAT/prod)
 */

export interface FeeCalculationContext {
  /** Full transaction amount paid by User A, in HBAR. */
  amountHbar: number;
  /** Travel product type — hotel, flight, etc. Affects fee tier. */
  productType: 'hotel' | 'flight' | 'other';
  /** Customer (white-label partner) ID. Null if Xeni direct. */
  customerId: string | null;
  /** Merchant-of-record mode. v1 is always 'xeni-mor'. */
  merchantMode: 'xeni-mor' | 'customer-mor';
  /** Booking reference ID, for audit linking. */
  bookingRef: string;
}

export interface FeeBreakdown {
  supplierCost: number;
  platformFee: number;
  customerCommission: number;
}

export interface FeeCalculator {
  /** Unique name for logging / health-check assertions. */
  readonly name: string;

  calculate(context: FeeCalculationContext): FeeBreakdown;
}
