/**
 * Synthetic pair-failure alert over Σ pairs_attempted / Σ pairs_succeeded in a heartbeat window.
 * Observer heartbeats lack per-leg pair deltas; provider drilldown splits Σ pairs_failed via
 * fetch/spread-error weights (same window). See docs/runbooks/observer-pair-failures.md.
 */

export const PAIR_FAILURE_ALERT_THRESHOLD = 0.1;
/** Sliding window Σ rows in pmci.observer_heartbeats (minutes). */
export const PAIR_FAILURE_WINDOW_MINUTES = 30;

function round4(n) {
  return Math.round(n * 1e4) / 1e4;
}

/** @param {number|null|undefined} fr */
export function ratioOrNull(fr) {
  if (fr == null || Number.isNaN(fr) || !Number.isFinite(fr)) return null;
  return round4(fr);
}

/**
 * @param {{
 *   pairs_attempted?: string|number|null,
 *   pairs_succeeded?: string|number|null,
 * }} agg
 */
export function buildTrueSuccessRateBlockFromAggregate(agg) {
  const pairs_attempted = Math.max(0, Number(agg?.pairs_attempted ?? 0));
  const pairs_succeeded = Math.max(0, Number(agg?.pairs_succeeded ?? 0));
  const pairs_failed = Math.max(0, pairs_attempted - pairs_succeeded);
  const failure_rate =
    pairs_attempted > 0 ? pairs_failed / pairs_attempted : null;

  const alert =
    pairs_attempted > 0 &&
    failure_rate != null &&
    failure_rate > PAIR_FAILURE_ALERT_THRESHOLD;

  return {
    window_minutes: PAIR_FAILURE_WINDOW_MINUTES,
    pairs_attempted,
    pairs_succeeded,
    pairs_failed,
    failure_rate,
    alert,
    alert_threshold: PAIR_FAILURE_ALERT_THRESHOLD,
    alert_reason: alert ? "polymarket_pair_failure_rate_exceeded" : null,
  };
}

/**
 * Heuristic drilldown using Σ fetch/spread diagnostics (same rows as aggregation).
 *
 * @param {{
 *   pairs_attempted: number|string,
 *   pairs_succeeded: number|string,
 *   sum_kalshi_fetch_errors: number|string,
 *   sum_polymarket_fetch_errors: number|string,
 *   sum_spread_insert_errors?: number|string,
 * }} agg
 */
export function buildByProviderDrilldown(agg) {
  const pairs_attempted = Math.max(0, Number(agg.pairs_attempted ?? 0));
  const pairs_succeeded = Math.max(0, Number(agg.pairs_succeeded ?? 0));
  const pairs_failed = Math.max(0, pairs_attempted - pairs_succeeded);

  const sum_k = Math.max(0, Number(agg.sum_kalshi_fetch_errors ?? 0));
  const sum_p = Math.max(0, Number(agg.sum_polymarket_fetch_errors ?? 0));
  const sum_si = Math.max(0, Number(agg.sum_spread_insert_errors ?? 0));

  const w = sum_k + sum_p + sum_si;
  let fk;
  let fp;
  let fspread;
  if (pairs_failed === 0) {
    fk = fp = fspread = 0;
  } else if (w === 0) {
    fk = fspread = 0;
    fp = pairs_failed;
  } else {
    fk = pairs_failed * (sum_k / w);
    fp = pairs_failed * (sum_p / w);
    fspread = pairs_failed * (sum_si / w);
  }

  /** Same denominator globally so ratios stay comparable window-over-window */
  function sub(fr) {
    return {
      pairs_attempted,
      pairs_succeeded,
      pairs_failed: round4(fr),
      failure_rate: pairs_attempted > 0 ? ratioOrNull(fr / pairs_attempted) : null,
    };
  }

  const polymarketMerged = fp + fspread * 0.5;
  const kalshiMerged = fk + fspread * 0.5;

  return {
    kalshi: {
      ...sub(kalshiMerged),
      attribution: "Estimated from Σ pairs_failed weighted by Σ kalshi_fetch_errors (+ half spread_insert_errors). Not per-leg causal.",
      fetch_error_events_sum: sum_k,
      spread_insert_events_sum_in_split: round4(fspread * 0.5),
    },
    polymarket: {
      ...sub(polymarketMerged),
      attribution:
        "Estimated from Σ pairs_failed weighted by Σ polymarket_fetch_errors (+ half spread_insert_errors). Aligns chronic ~19% when Poly signals dominate.",
      fetch_error_events_sum: sum_p,
      spread_insert_events_sum_in_split: round4(fspread * 0.5),
    },
  };
}
