/**
 * Polymarket subgraph (The Graph / Goldsky) — GET-only GraphQL queries.
 * Set POLYMARKET_SUBGRAPH_URL to the deployment you want (no default; operators must pin).
 */

function subgraphUrl() {
  const u = process.env.POLYMARKET_SUBGRAPH_URL?.trim();
  if (!u) {
    throw new Error(
      "POLYMARKET_SUBGRAPH_URL is not set (required for subgraph queries)",
    );
  }
  return u;
}

/**
 * GET GraphQL query against the subgraph HTTP endpoint.
 * @param {string} query
 * @param {Record<string, unknown>} [variables]
 * @param {{ timeoutMs?: number }} [options]
 */
export async function subgraphGet(query, variables = {}, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const base = subgraphUrl();
  const params = new URLSearchParams();
  params.set("query", query);
  if (Object.keys(variables).length > 0) {
    params.set("variables", JSON.stringify(variables));
  }
  const url = `${base}?${params.toString()}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`Subgraph HTTP ${res.status}: ${res.statusText}`);
    }
    const json = await res.json();
    if (json.errors?.length) {
      throw new Error(
        json.errors.map((e) => e.message || String(e)).join("; "),
      );
    }
    return json.data;
  } finally {
    clearTimeout(t);
  }
}

/** Example: recent resolved markets (schema names must match your subgraph). */
export const RESOLVED_MARKETS_QUERY = `
  query ResolvedMarkets($first: Int!, $skip: Int!) {
    markets(
      first: $first
      skip: $skip
      orderBy: endDate
      orderDirection: desc
      where: { closed: true }
    ) {
      id
      volume
    }
  }
`;

/** Example: historical trades (fields depend on subgraph version). */
export const TRADES_QUERY = `
  query Trades($first: Int!, $skip: Int!) {
    orderFilleds(first: $first, skip: $skip, orderBy: timestamp, orderDirection: desc) {
      id
      timestamp
    }
  }
`;
