/**
 * Polymarket taker fee parameters by market category (static schedule).
 *
 * Formula: fee_usd = round_5dp( C × feeRate × p × (1 − p) )
 * - C = shares (contracts)
 * - p = price of the traded outcome in USDC (0–1)
 * - Makers are never charged; only takers pay per docs.
 *
 * Source (observed 2026-04-19):
 * https://docs.polymarket.com/trading/fees
 *
 * Confidence: published_by_protocol_docs.
 * What would change this: Protocol updates feeRate per category; per-market flags via getClobMarketInfo(conditionID)
 * (feesEnabled, fd.r). v1 uses category defaults only — not per-market overrides.
 */

export const POLYMARKET_TAKER_FEE_RATE_BY_CATEGORY = Object.freeze({
  crypto: 0.072,
  sports: 0.03,
  finance: 0.04,
  politics: 0.04,
  economics: 0.05,
  culture: 0.05,
  weather: 0.05,
  other: 0.05,
  mentions: 0.04,
  tech: 0.04,
  geopolitics: 0,
});

/** Per docs: fees rounded to 5 decimal places; minimum charged 0.00001 USDC. */
export function polymarketTakerFeeUsd({ contracts, contractPrice, category = "sports" }) {
  const rate = POLYMARKET_TAKER_FEE_RATE_BY_CATEGORY[category];
  if (rate == null) throw new Error(`polymarket: unknown fee category "${category}"`);
  const C = Number(contracts);
  const p = Number(contractPrice);
  if (!(C >= 0) || !(p >= 0 && p <= 1)) return 0;
  const raw = C * rate * p * (1 - p);
  const rounded = Math.round(raw * 1e5) / 1e5;
  // Docs: fees below 0.00001 USDC round to zero.
  if (rounded < 0.00001) return 0;
  return rounded;
}
