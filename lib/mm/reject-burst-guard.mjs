/** Track Kalshi placement failures per ticker; auto-skip after a burst (rotator storm guard). */

export const MM_REJECT_BURST_WINDOW_MS = 60_000;
export const MM_REJECT_BURST_THRESHOLD = 10;

/**
 * Prune stale failure timestamps and remove tickers from the skip set once the burst
 * window no longer exceeds the threshold — otherwise a skipped ticker never calls back
 * into `recordMmPlacementFailure` and would stay skipped for the entire process lifetime.
 *
 * @param {Record<string, unknown>} sessionState
 * @param {number} [nowMs]
 */
export function reconcileMmRejectBurstSkips(sessionState, nowMs = Date.now()) {
  const st = ensureMmRejectState(sessionState);
  /** @type {Record<string, number[]>} */
  const by = /** @type {Record<string, number[]>} */ (st.rejectBurstByTicker);
  const skippedSet = /** @type {Set<string>} */ (st.skippedPlacementTickers);

  for (const [tRaw, timestamps] of Object.entries(by)) {
    const prev = Array.isArray(timestamps) ? /** @type {number[]} */ (timestamps) : [];
    const pruned = prev.filter((ts) => nowMs - ts < MM_REJECT_BURST_WINDOW_MS);
    if (pruned.length === 0) {
      delete by[tRaw];
      skippedSet.delete(tRaw);
    } else if (pruned.length <= MM_REJECT_BURST_THRESHOLD) {
      by[tRaw] = pruned;
      skippedSet.delete(tRaw);
    } else {
      by[tRaw] = pruned;
    }
  }

  for (const t of [...skippedSet]) {
    const arr = by[t];
    if (arr != null && arr.length > MM_REJECT_BURST_THRESHOLD) continue;
    skippedSet.delete(t);
  }

  return st;
}

/**
 * @param {Record<string, unknown>} sessionState orchestrator loop `state` object (mutated)
 */
export function ensureMmRejectState(sessionState) {
  if (!sessionState.rejectBurstByTicker) sessionState.rejectBurstByTicker = {};
  if (!sessionState.skippedPlacementTickers) sessionState.skippedPlacementTickers = new Set();
  return sessionState;
}

/**
 * @param {Record<string, unknown>} sessionState
 * @param {string} ticker
 */
export function recordMmPlacementFailure(sessionState, ticker) {
  const st = ensureMmRejectState(sessionState);
  const t = String(ticker);
  const now = Date.now();
  const prev = /** @type {number[]} */ (st.rejectBurstByTicker[t] ?? []);
  const pruned = prev.filter((ts) => now - ts < MM_REJECT_BURST_WINDOW_MS);
  pruned.push(now);
  st.rejectBurstByTicker[t] = pruned;
  if (pruned.length > MM_REJECT_BURST_THRESHOLD) {
    const skippedSet = /** @type {Set<string>} */ (st.skippedPlacementTickers);
    const newlySkipped = !skippedSet.has(t);
    skippedSet.add(t);
    if (newlySkipped) {
      try {
        console.warn(
          "mm.reject_burst.skip_ticker",
          JSON.stringify({
            ticker: t,
            failures_in_window: pruned.length,
            window_ms: MM_REJECT_BURST_WINDOW_MS,
            threshold: MM_REJECT_BURST_THRESHOLD,
          }),
        );
      } catch {
        console.warn("mm.reject_burst.skip_ticker", {
          ticker: t,
          failures_in_window: pruned.length,
        });
      }
    }
  }
}

/**
 * @param {Record<string, unknown>} sessionState
 * @param {string} ticker
 */
export function recordMmPlacementSuccess(sessionState, ticker) {
  const st = ensureMmRejectState(sessionState);
  const t = String(ticker);
  delete /** @type {Record<string, number[]>} */ (st.rejectBurstByTicker)[t];
  /** @type {Set<string>} */ (st.skippedPlacementTickers).delete(t);
}

/**
 * @param {Record<string, unknown>} sessionState
 * @param {string} ticker
 */
export function isTickerSkippedForPlacementBurst(sessionState, ticker) {
  return /** @type {Set<string>|undefined} */ (sessionState?.skippedPlacementTickers)?.has(String(ticker)) === true;
}
