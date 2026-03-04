/**
 * PMCI ingestion: upsert provider_markets, append provider_market_snapshots.
 * Used by the observer to keep pmci tables in sync for DEM/GOP nominee markets.
 * Requires DATABASE_URL. Provider IDs are resolved by code (kalshi, polymarket); no hardcoding.
 */

import pg from 'pg';

const { Client } = pg;

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
    metadata
  ) VALUES (
    $1, $2, $3, $4, $5,
    $6, $7, $8::timestamptz, $9::timestamptz,
    $10, now(), $11::jsonb
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
    metadata = EXCLUDED.metadata
  RETURNING id;
`;

const SQL_INSERT_SNAPSHOT = `
  INSERT INTO pmci.provider_market_snapshots (
    provider_market_id, observed_at, price_yes, best_bid_yes, best_ask_yes, liquidity, volume_24h, raw
  ) VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8::jsonb);
`;

/**
 * Create a pg Client if DATABASE_URL is set; otherwise null.
 * Caller must call client.end() when done (or use a shared pool).
 */
export function createPmciClient() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return null;
  return new Client({ connectionString: url });
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
    status,
    toJsonb(metadata),
  ]);
  return res.rows?.[0]?.id ?? null;
}

/**
 * Append a snapshot row for a provider market.
 */
export async function appendProviderMarketSnapshot(client, input) {
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

  if (!client || !providerMarketId || !observedAt) return false;

  await client.query(SQL_INSERT_SNAPSHOT, [
    providerMarketId,
    observedAt,
    priceYes,
    bestBidYes,
    bestAskYes,
    liquidity,
    volume24h,
    toJsonb(raw),
  ]);
  return true;
}

/**
 * Ingest a single provider market + optional snapshot (if priceYes is a number).
 * Returns { marketsUpserted: 1|0, snapshotsAppended: 1|0 }.
 */
export async function ingestProviderMarket(client, market, observedAt) {
  if (!client || !market || !observedAt) return { marketsUpserted: 0, snapshotsAppended: 0 };

  try {
    const id = await upsertProviderMarket(client, market);
    if (id == null) return { marketsUpserted: 0, snapshotsAppended: 0 };

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

    return { marketsUpserted: 1, snapshotsAppended: shouldSnap ? 1 : 0 };
  } catch (err) {
    console.error('PMCI ingestProviderMarket error for', market?.providerMarketRef, err.message);
    return { marketsUpserted: 0, snapshotsAppended: 0 };
  }
}

/**
 * Run PMCI ingestion for one (candidate, event) pair: upsert two provider_markets (Kalshi + Polymarket)
 * and append two snapshots. observedAt = ISO string.
 * providerIds must be { kalshi, polymarket } from getProviderIds(); if null, returns 0/0.
 * Returns { marketsUpserted: 2, snapshotsAppended: 2 } or { marketsUpserted: 0, snapshotsAppended: 0 } on skip/error.
 */
export async function ingestPair(client, pair, kalshiData, polymarketData, observedAt, providerIds) {
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
    kalshiId = await upsertProviderMarket(client, {
      providerId: providerIds.kalshi,
      providerMarketRef: pair.kalshiTicker,
      eventRef,
      title: titleKalshi,
      category,
      status: 'open',
      metadata: { source: 'observer', candidate: pair.polymarketOutcomeName, mode: 'paired' },
    });

    polymarketId = await upsertProviderMarket(client, {
      providerId: providerIds.polymarket,
      providerMarketRef: polymarketRef,
      eventRef,
      title: titlePoly,
      category,
      status: 'open',
      metadata: { source: 'observer', candidate: pair.polymarketOutcomeName, mode: 'paired' },
    });

    const priceKalshi = kalshiData?.yes ?? kalshiData?.yesAsk ?? kalshiData?.yesBid;
    const pricePoly = polymarketData?.yes ?? polymarketData?.bestAsk ?? polymarketData?.bestBid;

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
      });
    }
    if (polymarketId != null && typeof pricePoly === 'number' && !Number.isNaN(pricePoly)) {
      await appendProviderMarketSnapshot(client, {
        providerMarketId: polymarketId,
        observedAt,
        priceYes: pricePoly,
        bestBidYes: polymarketData?.bestBid ?? null,
        bestAskYes: polymarketData?.bestAsk ?? null,
        liquidity: null,
        volume24h: null,
        raw: polymarketData || {},
      });
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
