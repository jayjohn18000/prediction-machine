/** Track Kalshi placement failures per ticker; auto-skip after a burst (rotator storm guard). */

export const MM_REJECT_BURST_WINDOW_MS = 60_000;
export const MM_REJECT_BURST_THRESHOLD = 10;

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
    /** @type {Set<string>} */ (st.skippedPlacementTickers).add(t);
  }
}

/**
 * @param {Record<string, unknown>} sessionState
 * @param {string} ticker
 */
export function recordMmPlacementSuccess(sessionState, ticker) {
  if (!sessionState?.rejectBurstByTicker) return;
  const t = String(ticker);
  delete sessionState.rejectBurstByTicker[t];
  /** @type {Set<string>|undefined} */ (sessionState.skippedPlacementTickers)?.delete(t);
}

/**
 * @param {Record<string, unknown>} sessionState
 * @param {string} ticker
 */
export function isTickerSkippedForPlacementBurst(sessionState, ticker) {
  return /** @type {Set<string>|undefined} */ (sessionState?.skippedPlacementTickers)?.has(String(ticker)) === true;
}
