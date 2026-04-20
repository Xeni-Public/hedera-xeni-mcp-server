// Authored-by: Anand Palanisamy - anand@xeni.com

/**
 * HBAR <-> tinybar math + number validation for use inside the
 * xeniIntentMandate plugin's hooks.
 *
 * 1 HBAR = 10^8 tinybar. All HBAR comparisons in guard hooks happen in
 * tinybar integer space (BigInt) to avoid the classic floating-point
 * rounding pitfall (0.1 + 0.2 !== 0.3).
 *
 * Precision bound: Math.round(hbar * 1e8) is exact while the product fits
 * within Number.MAX_SAFE_INTEGER (~9e15), i.e. hbar <= ~9e7 (~90M HBAR).
 * v1 spend ceilings and mandate budgets are bounded far below this (refund
 * cap is 10k HBAR/day; per-user mandates even smaller). BigInt handles the
 * comparison of larger integers but can't recover precision lost during
 * the float multiply.
 */

export const TINYBAR_PER_HBAR = 100_000_000;

/**
 * Convert HBAR (float) to tinybar (BigInt). Uses Math.round to recover the
 * integer after float multiplication (e.g. (0.1 + 0.2) * 1e8 evaluates to
 * 30000000.000000004 in float, which rounds to 30000000).
 */
export function toTinybar(hbar: number): bigint {
  return BigInt(Math.round(hbar * TINYBAR_PER_HBAR));
}

/**
 * Convert tinybar (BigInt) back to HBAR (float).
 *
 * `Number(bigint)` loses precision when the BigInt exceeds 2^53
 * (`Number.MAX_SAFE_INTEGER`, ~9e15 tinybar = ~90M HBAR); the subsequent
 * `/ 1e8` then yields a lossy HBAR value. v1 use cases (refund cap
 * 10k HBAR/day; per-user mandates smaller still) sit far below this
 * ceiling. Callers that could exceed ~90M HBAR must either keep values
 * in tinybar or pass the BigInt through unconverted.
 */
export function fromTinybar(tb: bigint): number {
  return Number(tb) / TINYBAR_PER_HBAR;
}

/**
 * Returns a human-readable reason string if `value` is not a valid
 * non-negative finite number. Returns null if valid.
 *
 * Guard hooks use this to fail-closed on any malformed numeric input
 * (NaN, ±Infinity, negative). The returned reason names the field so
 * the caller (AgentService) sees exactly which input was bad.
 */
export function invalidNumberReason(value: number, name: string): string | null {
  if (!Number.isFinite(value)) return `${name} is not a finite number`;
  if (value < 0) return `${name} is negative`;
  return null;
}
