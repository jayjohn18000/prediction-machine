/**
 * Kalshi: fetch authoritative settlement for a market ticker via public GET /markets/{ticker}.
 * @see https://docs.kalshi.com/api-reference/market/get-market
 */
import { retry, fetchWithTimeout } from "../retry.mjs";

export const KALSHI_BASES = [
  "https://api.elections.kalshi.com/trade-api/v2",
  "https://api.kalshi.com/trade-api/v2",
];

let stickyBase = null;

function parseMarketPayload(data, base, path) {
  const resolutionSource = `${base} GET ${path}`;
  const market = data?.market;
  const raw = data && typeof data === "object" ? data : {};
  if (!market) {
    return {
      settled: false,
      winningOutcome: null,
      winningOutcomeRaw: null,
      resolvedAt: null,
      raw,
      resolutionSource,
    };
  }

  const result = market.result;
  const hasResult =
    result != null && result !== "" && String(result).trim() !== "";

  const resolvedAt = market.settlement_ts ?? null;
  const winningOutcomeRaw = {
    result: market.result ?? null,
    status: market.status ?? null,
    settlement_ts: market.settlement_ts ?? null,
    settlement_value_dollars: market.settlement_value_dollars ?? null,
  };

  if (!hasResult) {
    return {
      settled: false,
      winningOutcome: null,
      winningOutcomeRaw,
      resolvedAt,
      raw,
      resolutionSource,
    };
  }

  return {
    settled: true,
    winningOutcome: String(result).toLowerCase(),
    winningOutcomeRaw,
    resolvedAt,
    raw,
    resolutionSource,
  };
}

/**
 * @param {string} ticker - provider_market_ref for Kalshi
 */
export async function fetchKalshiMarketOutcome(ticker) {
  const path = `/markets/${encodeURIComponent(ticker)}`;

  async function fetchFromBase(base) {
    const url = `${base}${path}`;
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
    const parsed = parseMarketPayload(data, base, path);
    return { ...parsed, httpStatus };
  }

  const order = stickyBase
    ? [stickyBase, ...KALSHI_BASES.filter((b) => b !== stickyBase)]
    : KALSHI_BASES;

  let last = null;
  for (const base of order) {
    const r = await fetchFromBase(base);
    last = r;
    if (r.httpStatus === 200 && r.raw && r.raw.market) {
      stickyBase = base;
      return r;
    }
  }

  return (
    last ?? {
      settled: false,
      winningOutcome: null,
      winningOutcomeRaw: null,
      resolvedAt: null,
      raw: {},
      resolutionSource: `${KALSHI_BASES[0]} GET ${path}`,
      httpStatus: 404,
    }
  );
}
