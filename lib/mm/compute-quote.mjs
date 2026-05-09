/**
 * Pure fair-value + quoting path shared by live orchestrator and backtest replay.
 * Orchestrator I/O (Kalshi REST, DB) stays outside; this module is deterministic given inputs.
 */

import { updateFairValue } from "./fair-value.mjs";
import { decideQuote } from "./quoting-engine.mjs";

/**
 * Match vol width estimate used when bid/ask are missing (see fetchKalshiMarketSnapshot).
 *
 * @param {{ bestBidCents?: number|null, bestAskCents?: number|null }} topOfBook
 */
export function deriveVolSpreadCents(topOfBook) {
  const yb = topOfBook?.bestBidCents;
  const ya = topOfBook?.bestAskCents;
  if (yb != null && ya != null && ya > yb) return Math.round(ya - yb);
  return Math.min(99, Number(globalThis.process?.env?.MM_DEFAULT_VOL_CE ?? 12));
}

/**
 * @param {object} p
 * @param {object} p.fvCarry fair-value carry (emaCents, lastEmitMs, updates, …)
 * @param {number} p.midKalshiCents
 * @param {number|null} [p.midPolyCents]
 * @param {number|null} [p.weightKalshiLiquidity]
 * @param {number|null} [p.weightPolyLiquidity]
 * @param {number} p.nowMs epoch ms
 * @param {number|null|undefined} [p.dtMs]
 * @param {number|null|undefined} [p.midObservedMs]
 * @param {number} [p.netContractsYes]
 * @param {object} p.mmConfig mm_market_config subset for decideQuote
 * @param {{ bestBidCents?: number|null, bestAskCents?: number|null }} [p.topOfBook]
 * @param {number|null|undefined} [p.spreadCents] if set, overrides deriveVolSpreadCents for volEstimate
 */
export function computeQuote(p) {
  const topOfBook = p.topOfBook ?? {};
  const spreadCents =
    p.spreadCents != null && Number.isFinite(Number(p.spreadCents))
      ? Number(p.spreadCents)
      : deriveVolSpreadCents(topOfBook);

  const fv = updateFairValue({
    state: p.fvCarry ?? {},
    midKalshiCents: p.midKalshiCents,
    midPolyCents: p.midPolyCents ?? null,
    weightKalshiLiquidity: p.weightKalshiLiquidity,
    weightPolyLiquidity: p.weightPolyLiquidity ?? null,
    nowMs: p.nowMs,
    dtMs: p.dtMs,
    midObservedMs: p.midObservedMs,
  });

  const q = decideQuote({
    fairCents: fv.fair_value_cents,
    netContractsYes: p.netContractsYes ?? 0,
    volEstimateCents: spreadCents,
    config: p.mmConfig,
    topOfBook,
  });

  return { fairValue: fv, quote: q, fvCarryNext: fv.carry };
}

/**
 * Prompt / backtest-friendly bundle: replay state + normalized snapshot + params carrying mmConfig.
 *
 * @param {{ fvCarry?: object, netContractsYes?: number, prevObservedMs?: number|null }} state
 * @param {{
 *   midCents: number,
 *   bestBidCents?: number|null,
 *   bestAskCents?: number|null,
 *   spreadCents?: number|null,
 *   observedAtMs: number,
 *   nowMs?: number,
 *   weightKalshiLiquidity?: number|null,
 *   midPolyCents?: number|null,
 *   weightPolyLiquidity?: number|null,
 * }} snapshot
 * @param {{ mmConfig: object }} hypothesisParams
 */
export function computeQuoteFromState(state, snapshot, hypothesisParams) {
  const nowMs = snapshot.nowMs ?? snapshot.observedAtMs;
  const dtMs =
    state.prevObservedMs != null && state.prevObservedMs > 0
      ? Math.max(0, snapshot.observedAtMs - state.prevObservedMs)
      : undefined;

  return computeQuote({
    fvCarry: state.fvCarry ?? {},
    midKalshiCents: snapshot.midCents,
    midPolyCents: snapshot.midPolyCents ?? null,
    weightKalshiLiquidity: snapshot.weightKalshiLiquidity ?? 1,
    weightPolyLiquidity: snapshot.weightPolyLiquidity ?? null,
    midObservedMs: snapshot.observedAtMs,
    nowMs,
    dtMs,
    netContractsYes: state.netContractsYes ?? 0,
    mmConfig: hypothesisParams.mmConfig,
    topOfBook: { bestBidCents: snapshot.bestBidCents, bestAskCents: snapshot.bestAskCents },
    spreadCents: snapshot.spreadCents ?? undefined,
  });
}
