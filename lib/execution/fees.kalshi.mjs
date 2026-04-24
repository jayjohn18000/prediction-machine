/**
 * Kalshi trading fee parameters (static schedule).
 *
 * Formula (taker): fee_usd = ceil_to_cents( KALSHI_TAKER_COEFF × C × P × (1 − P) )
 * Formula (maker): fee_usd = ceil_to_cents( KALSHI_MAKER_COEFF × C × P × (1 − P) )
 * - C = contracts (integer count; fractional contracts exist on Kalshi — v1 passes fractional C through)
 * - P = price in dollars (0–1) of the contract side being traded (YES price or NO price)
 *
 * Sources (observed 2026-04-19):
 * - Coefficients and ceil-to-cent pattern: internal summary aligned with Kalshi fee schedule PDF
 *   https://kalshi.com/docs/kalshi-fee-schedule.pdf (429 at fetch time; treat as canonical when reachable)
 * - Fee rounding / cent alignment mechanics: Kalshi API docs
 *   https://docs.kalshi.com/getting_started/fee_rounding
 *
 * Confidence: published_by_venue (coefficients match widely reproduced schedule; verify PDF when 429 clears).
 * What would change this: Kalshi announces new multipliers via fee schedule / series fee API
 * (https://docs.kalshi.com/api-reference/exchange/get-series-fee-changes).
 */

export const KALSHI_TAKER_COEFF = 0.07;
export const KALSHI_MAKER_COEFF = 0.0175;

/** Round fee upward to whole cents (conservative vs sub-cent trade fees). */
export function kalshiFeeUsdCeilCents({ contracts, contractPrice, liquidityRole = "taker" }) {
  const coeff = liquidityRole === "maker" ? KALSHI_MAKER_COEFF : KALSHI_TAKER_COEFF;
  const C = Number(contracts);
  const P = Number(contractPrice);
  if (!(C >= 0) || !(P >= 0 && P <= 1)) return 0;
  const raw = coeff * C * P * (1 - P);
  return Math.ceil(raw * 100 - 1e-12) / 100;
}
