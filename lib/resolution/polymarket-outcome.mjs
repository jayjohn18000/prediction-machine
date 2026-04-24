/**
 * Polymarket CLOB: authoritative settlement via GET /markets/{condition_id}.
 * Winning outcome: token with winner === true.
 */
import { retry, fetchWithTimeout } from "../retry.mjs";

export const POLYMARKET_CLOB_BASE = "https://clob.polymarket.com";

/**
 * @param {string} conditionId - provider_market_ref (0x… hex)
 * @returns {Promise<{
 *   settled: boolean,
 *   winningOutcome: string | null,
 *   winningOutcomeRaw: object | null,
 *   resolvedAt: string | null,
 *   raw: object,
 *   resolutionSource: string,
 *   httpStatus: number
 * }>}
 */
export async function fetchPolymarketMarketOutcome(conditionId) {
  const path = `/markets/${encodeURIComponent(conditionId)}`;
  const url = `${POLYMARKET_CLOB_BASE}${path}`;
  const resolutionSource = `${POLYMARKET_CLOB_BASE} GET ${path}`;

  const res = await retry(
    () => fetchWithTimeout(url, {}, 20_000),
    { maxAttempts: 2, baseDelayMs: 600 },
  );
  const httpStatus = res.status;
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  const raw = data && typeof data === "object" ? data : {};
  if (!res.ok || data?.error) {
    return {
      settled: false,
      winningOutcome: null,
      winningOutcomeRaw: null,
      resolvedAt: null,
      raw,
      resolutionSource,
      httpStatus,
    };
  }

  const tokens = Array.isArray(data?.tokens) ? data.tokens : [];
  const winners = tokens.filter((t) => t && t.winner === true);
  if (winners.length === 0) {
    return {
      settled: false,
      winningOutcome: null,
      winningOutcomeRaw: null,
      resolvedAt: data.end_date_iso ?? null,
      raw,
      resolutionSource,
      httpStatus,
    };
  }

  const w = winners[0];
  const winningOutcomeRaw = {
    token_id: w.token_id ?? null,
    outcome: w.outcome ?? null,
    price: w.price ?? null,
    winner: w.winner === true,
  };

  return {
    settled: true,
    winningOutcome: String(w.outcome ?? "").trim() || "unknown",
    winningOutcomeRaw,
    resolvedAt: data.end_date_iso ?? null,
    raw,
    resolutionSource,
    httpStatus,
  };
}
