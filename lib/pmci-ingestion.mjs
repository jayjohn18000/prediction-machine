/**
 * PMCI ingestion: upsert provider_markets, append provider_market_snapshots.
 * Used by the observer to keep pmci tables in sync for DEM/GOP nominee markets.
 * Requires DATABASE_URL. Provider IDs are resolved by code (kalshi, polymarket); no hardcoding.
 */

import { createClient } from '../src/platform/db.mjs';
import { embed, embedBatch, toPgVectorLiteral } from './embeddings.mjs';

const SQL_GET_PROVIDER_IDS = `
  SELECT id, code FROM pmci.providers WHERE code IN ('kalshi', 'polymarket');
`;

const SQL_UPSERT_MARKET = `
  INSERT INTO pmci.provider_markets (
    provider_id,
    provider_market_ref,
    event_ref,
    title,
    category,
    url,
    market_type,
    open_time,
    close_time,
    status,
    last_seen_at,
    metadata,
    election_phase,
    subject_type,
    sport,
    event_type,
    game_date,
    home_team,
    away_team,
    volume_24h
  ) VALUES (
    $1, $2, $3, $4, $5,
    $6, $7, $8::timestamptz, $9::timestamptz,
    $10, now(), $11::jsonb,
    $12, $13,
    $14, $15, $16::date, $17, $18,
    $19
  )
  ON CONFLICT (provider_id, provider_market_ref) DO UPDATE SET
    event_ref = EXCLUDED.event_ref,
    title = EXCLUDED.title,
    category = EXCLUDED.category,
    url = EXCLUDED.url,
    market_type = EXCLUDED.market_type,
    open_time = EXCLUDED.open_time,
    close_time = EXCLUDED.close_time,
    status = EXCLUDED.status,
    last_seen_at = now(),
    metadata = EXCLUDED.metadata,
    election_phase = COALESCE(EXCLUDED.election_phase, provider_markets.election_phase),
    subject_type = COALESCE(EXCLUDED.subject_type, provider_markets.subject_type),
    sport = COALESCE(EXCLUDED.sport, provider_markets.sport),
    event_type = COALESCE(EXCLUDED.event_type, provider_markets.event_type),
    game_date = COALESCE(EXCLUDED.game_date, provider_markets.game_date),
    home_team = COALESCE(EXCLUDED.home_team, provider_markets.home_team),
    away_team = COALESCE(EXCLUDED.away_team, provider_markets.away_team),
    volume_24h = COALESCE(EXCLUDED.volume_24h, provider_markets.volume_24h)
  RETURNING id;
`;

const SQL_INSERT_SNAPSHOT = `
  INSERT INTO pmci.provider_market_snapshots (
    provider_market_id, observed_at, price_yes, best_bid_yes, best_ask_yes, liquidity, volume_24h, raw
  ) VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8::jsonb);
`;

const SQL_SELECT_MARKET_FOR_EMBEDDING = `
  SELECT id, title, title_embedding
  FROM pmci.provider_markets
  WHERE id = $1
`;

const SQL_UPDATE_TITLE_EMBEDDING = `
  UPDATE pmci.provider_markets
  SET title_embedding = $1::vector
  WHERE id = $2
`;

/**
 * Create a pg Client if DATABASE_URL is set; otherwise null.
 * Caller must call client.end() when done (or use a shared pool).
 */
export function createPmciClient() {
  try {
    return createClient();
  } catch {
    return null;
  }
}

/**
 * Resolve provider IDs by code. Returns { kalshi: id, polymarket: id } or null if either missing.
 * Call after connect(); if null, disable PMCI ingestion and log.
 */
export async function getProviderIds(client) {
  if (!client) return null;
  const res = await client.query(SQL_GET_PROVIDER_IDS);
  const byCode = new Map((res.rows || []).map((r) => [r.code, r.id]));
  const kalshi = byCode.get('kalshi') ?? null;
  const polymarket = byCode.get('polymarket') ?? null;
  if (kalshi == null || polymarket == null) return null;
  return { kalshi, polymarket };
}

function toJsonb(v) {
  if (v == null) return '{}';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return '{}';
  }
}

const STATUS_CANONICAL_MAP = {
  active: 'open',
  open: 'open',
  closed: 'closed',
  settled: 'settled',
};

/**
 * Normalize provider-native market status to canonical values: open, closed, settled.
 * Polymarket "active" -> "open"; Kalshi "open" passes through; unknown values warn and pass through.
 */
export function normalizeMarketStatus(rawStatus) {
  if (rawStatus == null || rawStatus === '') return null;
  const lower = String(rawStatus).toLowerCase().trim();
  const canonical = STATUS_CANONICAL_MAP[lower];
  if (canonical) return canonical;
  console.warn(`PMCI normalizeMarketStatus: unknown status "${rawStatus}" — passing through`);
  return lower;
}

/**
 * Upsert a provider market and return its pmci.provider_markets.id.
 */
export async function upsertProviderMarket(client, input) {
  const {
    providerId,
    providerMarketRef,
    eventRef = null,
    title,
    category = null,
    url = null,
    marketType = null,
    openTime = null,
    closeTime = null,
    status = null,
    metadata = {},
    electionPhase = null,
    subjectType = null,
    sport = null,
    eventType = null,
    gameDate = null,
    homeTeam = null,
    awayTeam = null,
    volume24h = null,
  } = input || {};

  if (!client || !providerId || !providerMarketRef || !title) return null;

  const res = await client.query(SQL_UPSERT_MARKET, [
    providerId,
    providerMarketRef,
    eventRef,
    title,
    category,
    url,
    marketType,
    openTime,
    closeTime,
    normalizeMarketStatus(status),
    toJsonb(metadata),
    electionPhase,
    subjectType,
    sport,
    eventType,
    gameDate,
    homeTeam,
    awayTeam,
    volume24h,
  ]);
  return res.rows?.[0]?.id ?? null;
}

/**
 * Ensure the given provider_markets row has a title_embedding.
 * No-op when the row is missing, has no title, or already has an embedding.
 */
async function ensureTitleEmbedding(client, providerMarketId) {
  if (!client || !providerMarketId) return;
  const res = await client.query(SQL_SELECT_MARKET_FOR_EMBEDDING, [providerMarketId]);
  const row = res.rows?.[0];
  if (!row) return;
  if (row.title_embedding != null) return;
  const title = row.title || '';
  if (!title.trim()) return;

  try {
    const vec = await embed(title);
    if (!Array.isArray(vec) || vec.length === 0) return;
    const literal = toPgVectorLiteral(vec);
    await client.query(SQL_UPDATE_TITLE_EMBEDDING, [literal, providerMarketId]);
  } catch (err) {
    // Embedding failures must not break ingestion; log and continue.
    console.error('PMCI ensureTitleEmbedding error for market_id', providerMarketId, err?.message || err);
  }
}

const EMBEDDING_BATCH_SIZE = 100;

const SQL_SELECT_MARKETS_FOR_EMBEDDING = `
  SELECT id, title, title_embedding
  FROM pmci.provider_markets
  WHERE id = ANY($1::int[]) AND title_embedding IS NULL AND title IS NOT NULL AND title != ''
`;

/**
 * Backfill title_embedding for a batch of provider_market IDs.
 * Uses OpenAI batch embedding to amortize latency. Safe to call with
 * IDs that already have embeddings -- they are skipped by the query.
 */
export async function backfillEmbeddings(client, providerMarketIds) {
  if (!client || !providerMarketIds?.length) return 0;
  let filled = 0;

  for (let i = 0; i < providerMarketIds.length; i += EMBEDDING_BATCH_SIZE) {
    const chunk = providerMarketIds.slice(i, i + EMBEDDING_BATCH_SIZE);
    const res = await client.query(SQL_SELECT_MARKETS_FOR_EMBEDDING, [chunk]);
    const rows = res.rows ?? [];
    if (rows.length === 0) continue;

    try {
      const titles = rows.map((r) => r.title);
      const vectors = await embedBatch(titles);

      for (let j = 0; j < rows.length; j++) {
        const vec = vectors[j];
        if (!Array.isArray(vec) || vec.length === 0) continue;
        const literal = toPgVectorLiteral(vec);
        await client.query(SQL_UPDATE_TITLE_EMBEDDING, [literal, rows[j].id]);
        filled++;
      }
    } catch (err) {
      console.error('PMCI backfillEmbeddings batch error:', err?.message || err);
    }
  }

  return filled;
}

/**
 * Append a snapshot row for a provider market.
 *
 * If `options.buffer` is provided, pushes the tuple onto the buffer instead
 * of issuing an INSERT. Call flushSnapshotBuffer(client, buffer) once per
 * observer cycle to commit the whole buffer as a single batched INSERT.
 * This collapses O(pairs) round-trips into O(cycle / BATCH_SIZE) — ~460
 * single-row INSERTs per cycle becomes ~3 multi-row INSERTs.
 */
export async function appendProviderMarketSnapshot(client, input, options = {}) {
  const {
    providerMarketId,
    observedAt,
    priceYes = null,
    bestBidYes = null,
    bestAskYes = null,
    liquidity = null,
    volume24h = null,
    raw = {},
  } = input || {};

  if (!providerMarketId || !observedAt) return false;

  const tuple = [
    providerMarketId,
    observedAt,
    priceYes,
    bestBidYes,
    bestAskYes,
    liquidity,
    volume24h,
    toJsonb(raw),
  ];

  if (options.buffer) {
    options.buffer.push(tuple);
    return true;
  }

  if (!client) return false;
  await client.query(SQL_INSERT_SNAPSHOT, tuple);
  return true;
}

/**
 * Flush an accumulated snapshot buffer as one or more multi-row INSERTs.
 *
 * Each chunk hits the DB as a single statement with 100 tuples * 8 params.
 * Postgres imposes a 65535 parameter limit per statement, so MAX_CHUNK must
 * stay <= 8000 tuples; 100 is a comfortable choice that also bounds WAL
 * record size and lock-hold time.
 *
 * @returns {Promise<number>} count of snapshots actually inserted (may be less
 *   than buffer.length if a chunk errored — we log and continue).
 */
export async function flushSnapshotBuffer(client, buffer, chunkSize = 100) {
  if (!client || !Array.isArray(buffer) || buffer.length === 0) return 0;
  let inserted = 0;
  for (let i = 0; i < buffer.length; i += chunkSize) {
    const chunk = buffer.slice(i, i + chunkSize);
    const placeholders = chunk.map((_, idx) => {
      const base = idx * 8;
      return `($${base + 1}, $${base + 2}::timestamptz, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}::jsonb)`;
    });
    const values = chunk.flat();
    const sql = `INSERT INTO pmci.provider_market_snapshots (provider_market_id, observed_at, price_yes, best_bid_yes, best_ask_yes, liquidity, volume_24h, raw) VALUES ${placeholders.join(', ')}`;
    try {
      await client.query(sql, values);
      inserted += chunk.length;
    } catch (err) {
      console.error(`PMCI snapshot-flush error (chunk ${i}..${i + chunk.length}):`, err.message);
    }
  }
  return inserted;
}

/**
 * Ingest a single provider market + optional snapshot (if priceYes is a number).
 * Returns { marketsUpserted: 1|0, snapshotsAppended: 1|0, providerMarketId: number|null }.
 *
 * @param {object} [options]
 * @param {boolean} [options.skipEmbedding=false] - Skip per-row embedding generation
 *   during bulk ingestion. Use backfillEmbeddings() after the batch completes.
 */
export async function ingestProviderMarket(client, market, observedAt, options = {}) {
  if (!client || !market || !observedAt) return { marketsUpserted: 0, snapshotsAppended: 0, providerMarketId: null };

  try {
    const id = await upsertProviderMarket(client, market);
    if (id == null) return { marketsUpserted: 0, snapshotsAppended: 0, providerMarketId: null };

    if (!options.skipEmbedding) {
      await ensureTitleEmbedding(client, id);
    }

    const priceYes = market?.priceYes;
    const shouldSnap = typeof priceYes === 'number' && !Number.isNaN(priceYes);

    if (shouldSnap) {
      await appendProviderMarketSnapshot(client, {
        providerMarketId: id,
        observedAt,
        priceYes,
        bestBidYes: market?.bestBidYes ?? null,
        bestAskYes: market?.bestAskYes ?? null,
        liquidity: market?.liquidity ?? null,
        volume24h: market?.volume24h ?? null,
        raw: market?.raw ?? {},
      });
    }

    return { marketsUpserted: 1, snapshotsAppended: shouldSnap ? 1 : 0, providerMarketId: id };
  } catch (err) {
    console.error('PMCI ingestProviderMarket error for', market?.providerMarketRef, err.message);
    return { marketsUpserted: 0, snapshotsAppended: 0, providerMarketId: null };
  }
}

const BATCH_UPSERT_SIZE = 50;

/**
 * Ingest a batch of provider markets + snapshots in fewer round-trips.
 * Upserts markets one-by-one (Postgres ON CONFLICT needs per-row RETURNING),
 * but batches snapshot inserts and embedding backfill.
 *
 * @param {object} client - pg client
 * @param {object[]} markets - array of market objects (same shape as ingestProviderMarket input)
 * @param {string} observedAt - ISO timestamp
 * @param {object} [options]
 * @param {boolean} [options.skipEmbedding=true] - defaults to true for batch operations
 * @returns {{ marketsUpserted: number, snapshotsAppended: number, providerMarketIds: number[] }}
 */
export async function ingestProviderMarketBatch(client, markets, observedAt, options = {}) {
  const skipEmbedding = options.skipEmbedding !== false;
  const result = { marketsUpserted: 0, snapshotsAppended: 0, providerMarketIds: [] };
  if (!client || !markets?.length || !observedAt) return result;

  const snapshots = [];

  for (const market of markets) {
    try {
      const id = await upsertProviderMarket(client, market);
      if (id == null) continue;
      result.marketsUpserted++;
      result.providerMarketIds.push(id);

      const priceYes = market?.priceYes;
      if (typeof priceYes === 'number' && !Number.isNaN(priceYes)) {
        snapshots.push([
          id, observedAt, priceYes,
          market?.bestBidYes ?? null, market?.bestAskYes ?? null,
          market?.liquidity ?? null, market?.volume24h ?? null,
          toJsonb(market?.raw ?? {}),
        ]);
      }
    } catch (err) {
      console.error('PMCI batch upsert error for', market?.providerMarketRef, err.message);
    }
  }

  for (let i = 0; i < snapshots.length; i += BATCH_UPSERT_SIZE) {
    const chunk = snapshots.slice(i, i + BATCH_UPSERT_SIZE);
    const placeholders = chunk.map((_, idx) => {
      const base = idx * 8;
      return `($${base + 1}, $${base + 2}::timestamptz, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}::jsonb)`;
    });
    const values = chunk.flat();
    const sql = `INSERT INTO pmci.provider_market_snapshots (provider_market_id, observed_at, price_yes, best_bid_yes, best_ask_yes, liquidity, volume_24h, raw) VALUES ${placeholders.join(', ')}`;
    try {
      await client.query(sql, values);
      result.snapshotsAppended += chunk.length;
    } catch (err) {
      console.error('PMCI batch snapshot insert error:', err.message);
    }
  }

  if (!skipEmbedding && result.providerMarketIds.length > 0) {
    await backfillEmbeddings(client, result.providerMarketIds);
  }

  return result;
}

/**
 * Run PMCI ingestion for one (candidate, event) pair: upsert two provider_markets (Kalshi + Polymarket)
 * and append two snapshots. observedAt = ISO string.
 * providerIds must be { kalshi, polymarket } from getProviderIds(); if null, returns 0/0.
 *
 * @param {object} [options]
 * @param {any[][]} [options.snapshotBuffer] - If provided, snapshot tuples
 *   are pushed onto this array for later batched flushing via
 *   flushSnapshotBuffer() instead of issuing per-pair INSERTs. The observer
 *   uses this to collapse ~460 single-row INSERTs per cycle into a handful
 *   of multi-row INSERTs — dramatically cuts WAL volume and round-trips,
 *   and reduces autovacuum pressure on provider_market_snapshots.
 *
 *   When using the buffer, snapshotsAppended in the return value reflects
 *   tuples STAGED, not yet committed. The caller is responsible for calling
 *   flushSnapshotBuffer() before the cycle ends.
 *
 * Returns { marketsUpserted: 2, snapshotsAppended: 2 } or { marketsUpserted: 0, snapshotsAppended: 0 } on skip/error.
 */
export async function ingestPair(client, pair, kalshiData, polymarketData, observedAt, providerIds, options = {}) {
  if (!client || !pair || !observedAt || !providerIds?.kalshi || !providerIds?.polymarket) {
    return { marketsUpserted: 0, snapshotsAppended: 0 };
  }

  const eventRef = pair.polymarketSlug;
  const category = eventRef || null;
  const titleKalshi = pair.eventName || pair.polymarketOutcomeName || pair.kalshiTicker;
  const titlePoly = pair.polymarketOutcomeName || pair.kalshiTicker;
  const polymarketRef = `${pair.polymarketSlug}#${pair.polymarketOutcomeName}`;

  let kalshiId = null;
  let polymarketId = null;

  try {
    const volK = kalshiData?.volume24h ?? kalshiData?.volume_24h ?? null;
    const volP =
      polymarketData?.volume24hr != null
        ? parseFloat(String(polymarketData.volume24hr))
        : polymarketData?.volume24h ?? polymarketData?.volume_24h ?? null;

    kalshiId = await upsertProviderMarket(client, {
      providerId: providerIds.kalshi,
      providerMarketRef: pair.kalshiTicker,
      eventRef,
      title: titleKalshi,
      category,
      status: 'open',
      metadata: {
        source: 'observer',
        candidate: pair.polymarketOutcomeName,
        mode: 'paired',
        slug: pair.polymarketSlug ? String(pair.polymarketSlug) : null,
      },
      volume24h: typeof volK === 'number' && !Number.isNaN(volK) ? volK : null,
    });

    polymarketId = await upsertProviderMarket(client, {
      providerId: providerIds.polymarket,
      providerMarketRef: polymarketRef,
      eventRef,
      title: titlePoly,
      category,
      status: 'open',
      metadata: {
        source: 'observer',
        candidate: pair.polymarketOutcomeName,
        mode: 'paired',
        slug: pair.polymarketSlug ? String(pair.polymarketSlug) : null,
      },
      volume24h: typeof volP === 'number' && !Number.isNaN(volP) ? volP : null,
    });

    // Ensure both paired markets have embeddings so downstream matching
    // can rely on title_embedding being present.
    await Promise.all([
      kalshiId != null ? ensureTitleEmbedding(client, kalshiId) : Promise.resolve(),
      polymarketId != null ? ensureTitleEmbedding(client, polymarketId) : Promise.resolve(),
    ]);

    const priceKalshi = kalshiData?.yes ?? kalshiData?.yesAsk ?? kalshiData?.yesBid;
    const pricePoly = polymarketData?.yes ?? polymarketData?.bestAsk ?? polymarketData?.bestBid;

    const snapshotOptions = options.snapshotBuffer ? { buffer: options.snapshotBuffer } : {};

    if (kalshiId != null && typeof priceKalshi === 'number' && !Number.isNaN(priceKalshi)) {
      await appendProviderMarketSnapshot(client, {
        providerMarketId: kalshiId,
        observedAt,
        priceYes: priceKalshi,
        bestBidYes: kalshiData?.yesBid ?? null,
        bestAskYes: kalshiData?.yesAsk ?? null,
        liquidity: kalshiData?.openInterest ?? null,
        volume24h: kalshiData?.volume24h ?? null,
        raw: kalshiData || {},
      }, snapshotOptions);
    }
    if (polymarketId != null && typeof pricePoly === 'number' && !Number.isNaN(pricePoly)) {
      const snapVolP =
        polymarketData?.volume24hr != null
          ? parseFloat(String(polymarketData.volume24hr))
          : polymarketData?.volume24h ?? polymarketData?.volume_24h ?? null;
      await appendProviderMarketSnapshot(client, {
        providerMarketId: polymarketId,
        observedAt,
        priceYes: pricePoly,
        bestBidYes: polymarketData?.bestBid ?? null,
        bestAskYes: polymarketData?.bestAsk ?? null,
        liquidity: polymarketData?.liquidity != null ? Number(polymarketData.liquidity) : null,
        volume24h: typeof snapVolP === 'number' && !Number.isNaN(snapVolP) ? snapVolP : null,
        raw: polymarketData || {},
      }, snapshotOptions);
    }

    const snapCount = (kalshiId != null && priceKalshi != null ? 1 : 0) + (polymarketId != null && pricePoly != null ? 1 : 0);
    return { marketsUpserted: 2, snapshotsAppended: snapCount };
  } catch (err) {
    console.error('PMCI ingestion error for', pair.polymarketOutcomeName, err.message);
    return { marketsUpserted: kalshiId != null && polymarketId != null ? 2 : 0, snapshotsAppended: 0 };
  }
}

/**
 * Aggregate counts for ingestion report.
 */
export function addIngestionCounts(acc, result) {
  acc.marketsUpserted += result.marketsUpserted ?? 0;
  acc.snapshotsAppended += result.snapshotsAppended ?? 0;
}

const SQL_INSERT_HEARTBEAT = `
  INSERT INTO pmci.observer_heartbeats (
    cycle_at, pairs_attempted, pairs_succeeded, pairs_configured,
    kalshi_fetch_errors, polymarket_fetch_errors,
    spread_insert_errors, pmci_ingestion_errors, json_parse_errors
  ) VALUES ($1::timestamptz, $2, $3, $4, $5, $6, $7, $8, $9)
`;

/**
 * Write a cycle heartbeat row. Intentionally silent on failure — heartbeat
 * errors must never crash the observer.
 */
export async function writeHeartbeat(client, metrics) {
  if (!client) return;
  try {
    await client.query(SQL_INSERT_HEARTBEAT, [
      metrics.cycleAt,
      metrics.pairsAttempted,
      metrics.pairsSucceeded,
      metrics.pairsConfigured,
      metrics.kalshiFetchErrors,
      metrics.polymarketFetchErrors,
      metrics.spreadInsertErrors,
      metrics.pmciIngestionErrors,
      metrics.jsonParseErrors,
    ]);
  } catch (_) {
    // Intentionally silent — heartbeat failure must never crash the observer.
  }
}

/**
 * Denormalized freshness cache maintenance.
 *
 * Keeps pmci.providers.last_snapshot_at in sync with the most recent
 * observed_at across pmci.provider_market_snapshots for each provider, so
 * that /v1/health/freshness (and computeLiveFreshnessSnapshot) can read
 * freshness without MAX()-scanning 3.5M snapshot rows.
 *
 * GREATEST() guards against out-of-order updates (e.g., the pmci sweep
 * finishing slightly after a pair write with an earlier observedAt — we
 * never want to regress the timestamp).
 *
 * Intentionally per-provider with explicit IDs rather than a subquery
 * against provider_market_snapshots: callers already know which providers
 * wrote snapshots in this cycle, and we don't want to touch the hot
 * snapshot table here.
 *
 * @param {import("pg").Client | null} client
 * @param {{ providerIds: number[], observedAt: string }} params
 */
export async function touchProvidersLastSnapshotAt(client, { providerIds, observedAt }) {
  if (!client || !observedAt || !Array.isArray(providerIds) || providerIds.length === 0) {
    return;
  }
  try {
    await client.query(
      `UPDATE pmci.providers
         SET last_snapshot_at = GREATEST(
           COALESCE(last_snapshot_at, 'epoch'::timestamptz),
           $1::timestamptz
         )
       WHERE id = ANY($2::int[])`,
      [observedAt, providerIds],
    );
  } catch (_) {
    // Intentionally silent — the cache can be refreshed by the next cycle.
    // This must never crash the observer.
  }
}
