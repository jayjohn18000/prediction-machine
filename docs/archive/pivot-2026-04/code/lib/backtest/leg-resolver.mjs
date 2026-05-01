/**
 * Tri-state leg resolver: given a provider_markets row, a side ('yes' | 'no'),
 * and the leg's winning_outcome, returns one of 'won' | 'lost' | 'void'.
 *
 * Void takes precedence: any indicator that the market did not settle
 * decisively (missing outcome, literal 'unknown', void/cancelled metadata)
 * resolves to 'void' regardless of side.
 *
 * Pure function — no DB, no clock reads. Delegates won/lost decisions to the
 * existing intra-venue helpers in leg-payout.mjs.
 */
import { kalshiLongYesPays, polyLongYesPays } from "./leg-payout.mjs";

const VOID_OUTCOME_TOKENS = new Set(["unknown", "void", "cancelled", "canceled", "invalid"]);
const VOID_STATUS_TOKENS = new Set([
  "void",
  "voided",
  "cancelled",
  "canceled",
  "invalid",
  "invalidated",
]);

function normToken(s) {
  return String(s ?? "").trim().toLowerCase();
}

function marketSignalsVoid(market) {
  if (!market || typeof market !== "object") return false;
  // Common fields that might be stamped when a venue voids/cancels a market.
  // We look at any of them defensively; the real data on pmci.provider_markets
  // rarely carries all of these, but checking is cheap and keeps the resolver
  // robust when new void signals appear.
  const candidates = [market.status, market.state, market.resolution, market.outcome_status];
  for (const c of candidates) {
    if (VOID_STATUS_TOKENS.has(normToken(c))) return true;
  }
  if (market.voided === true || market.cancelled === true || market.canceled === true) return true;
  return false;
}

/**
 * @param {object} params
 * @param {object} params.market          - provider_markets row (must include `provider` = 'kalshi'|'polymarket').
 * @param {'yes'|'no'} params.side        - Which side the leg is long.
 * @param {string|null|undefined} params.winningOutcome - Venue-reported winning outcome (may be null/''/'unknown').
 * @returns {'won'|'lost'|'void'}
 */
export function resolveLeg({ market, side, winningOutcome }) {
  if (side !== "yes" && side !== "no") {
    throw new Error(`resolveLeg: side must be "yes" or "no" (got ${side})`);
  }

  // Void precedence: missing / literal 'unknown' / empty / venue says cancelled.
  if (winningOutcome == null) return "void";
  const token = normToken(winningOutcome);
  if (token === "" || VOID_OUTCOME_TOKENS.has(token)) return "void";
  if (marketSignalsVoid(market)) return "void";

  const provider = normToken(market?.provider);
  let longYesWins;
  if (provider === "kalshi") {
    longYesWins = kalshiLongYesPays({ winning_outcome: winningOutcome });
  } else if (provider === "polymarket") {
    longYesWins = polyLongYesPays(market, winningOutcome);
  } else {
    throw new Error(`resolveLeg: unknown provider "${market?.provider}"`);
  }

  if (side === "yes") return longYesWins ? "won" : "lost";
  // side === 'no'
  return longYesWins ? "lost" : "won";
}
