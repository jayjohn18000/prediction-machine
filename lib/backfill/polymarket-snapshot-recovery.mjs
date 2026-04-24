/**
 * Polymarket snapshot backfill via CLOB /prices-history.
 *
 * Why this exists: the observer only snapshots currently-active markets off
 * the gamma-api. Once a Polymarket market settles, gamma drops it and the
 * observer stops capturing prices. For backtesting settled markets we need
 * historical price series, which CLOB /prices-history does expose publicly.
 *
 * Scope: populates pmci.provider_market_snapshots for Polymarket pmids only.
 * Kalshi backfill is a separate concern (Kalshi historical API is different).
 *
 * Invariants:
 * - Idempotent: uses anti-join NOT EXISTS so a row is only inserted when
 *   (provider_market_id, observed_at) doesn't already live in the table.
 *   Deliberately does not rely on a unique constraint because the existing
 *   observer writer doesn't declare one (only a non-unique index exists),
 *   and we don't want this tool to require a schema migration to run.
 * - Fetches both daily (fidelity=1440) and minute (fidelity=60) fidelities
 *   and dedupes; minute-fidelity wins on ties because it has more precision.
 *   Daily gives full lifecycle; minute gives fine granularity on recent window.
 * - Snapshots are keyed to the YES clob token id extracted from pm.metadata.
 *   NO-token prices are implied as (1 - yes) and NOT persisted separately.
 * - Stamps metadata.source = 'clob-backfill' on the raw column so a future
 *   observer re-capture doesn't confuse backfilled rows with live ones.
 */
const CLOB_BASE = "https://clob.polymarket.com";

/**
 * Extract YES token id from a provider_markets.metadata blob.
 * @param {object|null|undefined} metadata
 * @returns {string|null}
 */
export function yesTokenFromMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return null;
  const raw =
    metadata.clob_token_ids ??
    metadata.clobTokenIds ??
    metadata.clob_tokens ??
    null;
  if (!raw) return null;
  const arr = Array.isArray(raw) ? raw : typeof raw === "string" ? safeJsonArray(raw) : [];
  if (!arr.length || typeof arr[0] !== "string") return null;
  return arr[0];
}

function safeJsonArray(s) {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * Fetch one fidelity of history for a given YES token id.
 * @param {string} yesTokenId
 * @param {number} fidelity  60 = minute resolution, 1440 = daily
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {Promise<{history: Array<{t: number, p: number}>}>}
 */
export async function fetchPricesHistory(yesTokenId, fidelity, opts = {}) {
  const f = opts.fetchImpl ?? fetch;
  const url = `${CLOB_BASE}/prices-history?market=${encodeURIComponent(yesTokenId)}&interval=max&fidelity=${fidelity}`;
  const res = await f(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`CLOB /prices-history ${res.status} for token=${yesTokenId.slice(0, 16)}…: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  const history = Array.isArray(json?.history) ? json.history : [];
  return { history };
}

/**
 * Merge two fidelity histories into a single deduped series.
 * Keys are second-precision `t` values. On conflict, prefer the higher-
 * fidelity (more recent) sample because it better reflects the instant.
 *
 * @param {Array<{t: number, p: number}>} daily
 * @param {Array<{t: number, p: number}>} minute
 * @returns {Array<{t: number, p: number}>}  sorted ascending by t
 */
export function mergeHistories(daily, minute) {
  const byT = new Map();
  for (const pt of daily) byT.set(Number(pt.t), Number(pt.p));
  for (const pt of minute) byT.set(Number(pt.t), Number(pt.p));  // minute overwrites daily on exact collision
  return Array.from(byT.entries())
    .map(([t, p]) => ({ t, p }))
    .sort((a, b) => a.t - b.t);
}

/**
 * Coerce a price_yes value to the database's allowed range.
 * /prices-history can return 0.0 or 1.0 on resolved outcome; we drop those
 * rather than store degenerate prices that would break the backtest's
 * [0,1]-open entry filter. The backtest's live-window entries never happen
 * at exact 0/1 anyway.
 *
 * @param {number} p
 * @returns {number|null}
 */
function coercePrice(p) {
  if (!Number.isFinite(p)) return null;
  if (p <= 0 || p >= 1) return null;
  return p;
}

/**
 * Backfill snapshots for a single Polymarket pmid.
 *
 * @param {object} params
 * @param {import('pg').Client} params.pg
 * @param {number|string} params.providerMarketId
 * @param {string} params.yesTokenId
 * @param {typeof fetch} [params.fetchImpl]
 * @param {number} [params.batchSize]  rows per INSERT, default 500
 * @returns {Promise<{ fetched: number, inserted: number, skippedDegenerate: number }>}
 */
export async function backfillOnePmid({
  pg: client,
  providerMarketId,
  yesTokenId,
  fetchImpl,
  batchSize = 500,
}) {
  const daily = await fetchPricesHistory(yesTokenId, 1440, { fetchImpl });
  const minute = await fetchPricesHistory(yesTokenId, 60, { fetchImpl });
  const merged = mergeHistories(daily.history, minute.history);

  let skippedDegenerate = 0;
  const rows = [];
  for (const pt of merged) {
    const price = coercePrice(pt.p);
    if (price == null) {
      skippedDegenerate += 1;
      continue;
    }
    const observedAt = new Date(pt.t * 1000).toISOString();
    rows.push([providerMarketId, observedAt, price]);
  }

  if (rows.length === 0) {
    return { fetched: merged.length, inserted: 0, skippedDegenerate };
  }

  let inserted = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    // Anti-join insert: SELECT ... FROM VALUES ... WHERE NOT EXISTS.
    // Idempotent without requiring a unique constraint we don't own.
    const values = [];
    const params = [];
    for (const [pmid, obs, price] of batch) {
      const base = params.length;
      params.push(pmid, obs, price, JSON.stringify({ source: "clob-backfill" }));
      values.push(`($${base + 1}::bigint, $${base + 2}::timestamptz, $${base + 3}::numeric, $${base + 4}::jsonb)`);
    }
    const sql = `
      INSERT INTO pmci.provider_market_snapshots
        (provider_market_id, observed_at, price_yes, raw)
      SELECT v.pmid, v.observed_at, v.price_yes, v.raw
      FROM (VALUES ${values.join(", ")}) AS v(pmid, observed_at, price_yes, raw)
      WHERE NOT EXISTS (
        SELECT 1 FROM pmci.provider_market_snapshots s
        WHERE s.provider_market_id = v.pmid AND s.observed_at = v.observed_at
      )
    `;
    const res = await client.query(sql, params);
    inserted += res.rowCount ?? 0;
  }
  return { fetched: merged.length, inserted, skippedDegenerate };
}

/**
 * Load candidate Polymarket pmids that need backfilling.
 *
 * Strategy: select all bilateral-sports Polymarket pmids linked today, filter
 * client-side to those with fewer than `minSnapshots` existing rows. The
 * count is done in-SQL so we don't re-pull metadata for well-covered markets.
 *
 * @param {import('pg').Client} pg
 * @param {object} [opts]
 * @param {number} [opts.minSnapshots]  default 10 — anything below is a backfill candidate
 * @returns {Promise<Array<{ pmid: string, externalRef: string, title: string, yesTokenId: string|null }>>}
 */
export async function loadPolymarketBackfillCandidates(pg, opts = {}) {
  const minSnapshots = opts.minSnapshots ?? 10;
  const sql = `
    WITH bilateral AS (
      SELECT c.family_id
      FROM pmci.v_market_links_current c
      JOIN pmci.provider_markets pm ON pm.id = c.provider_market_id
      WHERE c.status = 'active' AND (pm.category = 'sports' OR pm.category IS NULL)
      GROUP BY c.family_id
      HAVING COUNT(*) = 2 AND COUNT(DISTINCT c.provider_id) = 2
    ),
    poly_pmids AS (
      SELECT DISTINCT pm.id::bigint AS pmid
      FROM bilateral bf
      JOIN pmci.v_market_links_current v ON v.family_id = bf.family_id
      JOIN pmci.provider_markets pm ON pm.id = v.provider_market_id
      JOIN pmci.providers pr ON pr.id = pm.provider_id
      WHERE pr.code = 'polymarket'
    ),
    snap_counts AS (
      SELECT provider_market_id, COUNT(*)::int AS n
      FROM pmci.provider_market_snapshots
      WHERE provider_market_id IN (SELECT pmid FROM poly_pmids)
      GROUP BY provider_market_id
    )
    SELECT pm.id::text AS pmid,
           pm.provider_market_ref AS external_ref,
           pm.title,
           pm.metadata,
           COALESCE(sc.n, 0) AS snap_count
    FROM poly_pmids pp
    JOIN pmci.provider_markets pm ON pm.id = pp.pmid
    LEFT JOIN snap_counts sc ON sc.provider_market_id = pm.id
    WHERE COALESCE(sc.n, 0) < $1
    ORDER BY pm.id
  `;
  const { rows } = await pg.query(sql, [minSnapshots]);
  return rows.map((r) => ({
    pmid: r.pmid,
    externalRef: r.external_ref,
    title: r.title,
    yesTokenId: yesTokenFromMetadata(r.metadata),
    currentSnapshots: Number(r.snap_count) || 0,
  }));
}

export { CLOB_BASE };
