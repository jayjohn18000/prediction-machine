/**
 * Cross-venue arb trade construction.
 *
 * Replaces the directional long-YES-on-both-legs v1 bet. The actual trade at
 * entry is: long YES on the cheap venue, long NO on the expensive venue, $100
 * total deployed per fixture. In a clean arb one side wins and the other
 * loses; in an A3 miss both sides can win (windfall) or both lose (wipe).
 *
 * Pure function — no DB, no clock reads. Numeric rounding is the aggregator's
 * job; this function emits full-precision floats.
 *
 * @typedef {import('./types.mjs').FixtureRow} FixtureRow
 */
import { estimateCost } from "../execution/costs.mjs";
import { resolveLeg } from "./leg-resolver.mjs";

export const PREMIUM_PER_TRADE_USD = 100;
export const VOID_REFUND_MODEL = "full_refund_v1";

/**
 * Construct an arb trade for a single fixture and return a FixtureRow-shaped
 * object with `skip: null`. Runs leg resolution, sizing, cost, and void-refund
 * accounting. Callers stamp template fields and pass the result through.
 *
 * @param {object} params
 * @param {number} params.kYesAtEntry        - Kalshi YES price at entry, in (0, 1).
 * @param {number} params.pYesAtEntry        - Polymarket YES price at entry, in (0, 1).
 * @param {object} params.kalshiMarket       - Kalshi leg's provider_markets row (must include provider='kalshi').
 * @param {object} params.polyMarket         - Polymarket leg's provider_markets row (must include provider='polymarket').
 * @param {string|null|undefined} params.kalshiWinningOutcome - Kalshi leg's winning_outcome (may be null/'unknown').
 * @param {string|null|undefined} params.polyWinningOutcome   - Polymarket leg's winning_outcome.
 * @param {number} params.holdDays           - Calendar days from entry to last leg resolution (integer).
 * @param {number} params.entryThresholdAbs  - Threshold this run used; stamped on the row.
 * @param {number} params.snapshotIntervalMs - Snapshot cadence used; stamped on the row.
 * @returns {{
 *   direction: 'k_cheap' | 'p_cheap',
 *   spread_at_entry: number,
 *   cheap_state: 'won'|'lost'|'void',
 *   exp_state: 'won'|'lost'|'void',
 *   gross_dollars: number,
 *   net_dollars: number,
 *   hold_days: number,
 *   cheap_costs_breakdown: object,
 *   exp_costs_breakdown: object,
 *   entry_threshold_used: number,
 *   snapshot_interval_ms: number,
 *   void_refund_model: string,
 *   skip: null,
 * }}
 */
export function arbTrade(params) {
  const {
    kYesAtEntry,
    pYesAtEntry,
    kalshiMarket,
    polyMarket,
    kalshiWinningOutcome,
    polyWinningOutcome,
    holdDays,
    entryThresholdAbs,
    snapshotIntervalMs,
  } = params;

  const kYes = Number(kYesAtEntry);
  const pYes = Number(pYesAtEntry);
  if (!Number.isFinite(kYes) || kYes <= 0 || kYes >= 1) {
    throw new RangeError(`arbTrade: kYesAtEntry must be in (0, 1) — got ${kYesAtEntry}`);
  }
  if (!Number.isFinite(pYes) || pYes <= 0 || pYes >= 1) {
    throw new RangeError(`arbTrade: pYesAtEntry must be in (0, 1) — got ${pYesAtEntry}`);
  }

  // 1. Direction: tie goes to k_cheap.
  const direction = kYes <= pYes ? "k_cheap" : "p_cheap";
  const spread_at_entry = Math.abs(kYes - pYes);

  let cheapVenue;
  let cheapMarket;
  let cheapOutcome;
  let cheapPriceYes;
  let expVenue;
  let expMarket;
  let expOutcome;
  let expPriceYes;
  if (direction === "k_cheap") {
    cheapVenue = "kalshi";
    cheapMarket = kalshiMarket;
    cheapOutcome = kalshiWinningOutcome;
    cheapPriceYes = kYes;
    expVenue = "polymarket";
    expMarket = polyMarket;
    expOutcome = polyWinningOutcome;
    expPriceYes = pYes;
  } else {
    cheapVenue = "polymarket";
    cheapMarket = polyMarket;
    cheapOutcome = polyWinningOutcome;
    cheapPriceYes = pYes;
    expVenue = "kalshi";
    expMarket = kalshiMarket;
    expOutcome = kalshiWinningOutcome;
    expPriceYes = kYes;
  }

  // 2. Cheap leg buys YES @ cheapPriceYes; expensive leg buys NO @ (1 - expPriceYes).
  const expPriceNo = 1 - expPriceYes;

  // 3. Size so $100 total premium covers both legs.
  //    N (contracts per leg) = 100 / (cheapPrice + expPriceNo).
  const N = PREMIUM_PER_TRADE_USD / (cheapPriceYes + expPriceNo);
  const cheapPremium = N * cheapPriceYes;
  const expPremium = N * expPriceNo;

  // Sanity: cheapPremium + expPremium ≈ 100 within $0.01.
  const premiumSum = cheapPremium + expPremium;
  if (Math.abs(premiumSum - PREMIUM_PER_TRADE_USD) > 0.01) {
    throw new Error(
      `arbTrade: premium sum invariant violated — cheap=${cheapPremium} exp=${expPremium} sum=${premiumSum}`,
    );
  }

  // 4. Resolve each leg.
  const cheapMarketWithProvider = { provider: cheapVenue, ...cheapMarket };
  const expMarketWithProvider = { provider: expVenue, ...expMarket };
  const cheap_state = resolveLeg({
    market: cheapMarketWithProvider,
    side: "yes",
    winningOutcome: cheapOutcome,
  });
  const exp_state = resolveLeg({
    market: expMarketWithProvider,
    side: "no",
    winningOutcome: expOutcome,
  });

  // 5. Gross per leg, pre-cost, pre-refund.
  const cheapGross = cheap_state === "won" ? N - cheapPremium : -cheapPremium;
  const expGross = exp_state === "won" ? N - expPremium : -expPremium;

  // 6. Costs per leg. estimateCost() expects YES probability regardless of side.
  const cheapCost = estimateCost({
    venue: cheapVenue,
    side: "yes",
    price: cheapPriceYes,
    size: cheapPremium,
    hold_days: holdDays,
    polymarket_category: "sports",
  });
  const expCost = estimateCost({
    venue: expVenue,
    side: "no",
    price: expPriceYes,
    size: expPremium,
    hold_days: holdDays,
    polymarket_category: "sports",
  });

  // 7. Apply void refund model v1: full refund of premium + fees + slippage +
  // lockup on a void leg. Non-void leg pays/receives normally.
  let cheapNet;
  if (cheap_state === "void") {
    cheapNet = 0;
  } else {
    cheapNet = cheapGross - cheapCost.total_cost_dollars;
  }
  let expNet;
  if (exp_state === "void") {
    expNet = 0;
  } else {
    expNet = expGross - expCost.total_cost_dollars;
  }

  const gross_dollars = cheapGross + expGross;
  const net_dollars = cheapNet + expNet;

  return {
    direction,
    spread_at_entry,
    cheap_state,
    exp_state,
    gross_dollars,
    net_dollars,
    hold_days: holdDays,
    cheap_costs_breakdown: cheapCost.breakdown,
    exp_costs_breakdown: expCost.breakdown,
    entry_threshold_used: entryThresholdAbs,
    snapshot_interval_ms: snapshotIntervalMs,
    void_refund_model: VOID_REFUND_MODEL,
    skip: null,
  };
}
