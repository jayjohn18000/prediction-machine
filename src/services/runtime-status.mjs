/**
 * Live snapshot of PMCI freshness (latest snapshot times + row counts).
 * Matches the shape read from pmci.pmci_runtime_status for the same logical fields.
 *
 * --- 2026-04-24 Disk IO rewrite ---
 * The previous implementation did a MAX(observed_at) over all 3.5M rows of
 * pmci.provider_market_snapshots plus four count(*) full-table scans. At ~40K
 * calls/day it was burning ~97% of the project's shared-block reads and
 * chewing through the Supabase Disk IO budget.
 *
 * The rewritten query reads:
 *   - Latest timestamps from pmci.providers.last_snapshot_at (denormalized
 *     column maintained by the observer batch-commit path — see
 *     lib/ingestion/observer-cycle.mjs). One-row lookups on a two-row table.
 *   - Approximate counts from pg_class.reltuples for the two large tables
 *     (provider_markets, provider_market_snapshots). The freshness endpoint
 *     only uses these to surface rough health numbers; a few percent of
 *     staleness is irrelevant and avoids two full-table scans. ANALYZE keeps
 *     these within ~1% of truth under the autovacuum settings we run.
 *   - Exact counts for the two small tables (market_families ~200 rows,
 *     market_links ~500 rows) — cheap index-free scans.
 *   - observer_last_run from observer_heartbeats (4K rows, indexed MAX).
 */
const RUNTIME_SNAPSHOT_SELECT = `
  with providers_summary as (
    select
      max(last_snapshot_at) as latest_snapshot_at,
      max(last_snapshot_at) filter (where code = 'kalshi') as latest_kalshi_snapshot_at,
      max(last_snapshot_at) filter (where code = 'polymarket') as latest_polymarket_snapshot_at
    from pmci.providers
  ),
  approx_counts as (
    select
      (select coalesce(reltuples::bigint, 0) from pg_class
        where oid = 'pmci.provider_markets'::regclass) as provider_markets_count,
      (select coalesce(reltuples::bigint, 0) from pg_class
        where oid = 'pmci.provider_market_snapshots'::regclass) as snapshot_count
  ),
  exact_counts as (
    select
      (select count(*)::int from pmci.market_families) as families_count,
      (select count(*)::int from pmci.v_market_links_current) as current_links_count,
      (select max(cycle_at) from pmci.observer_heartbeats) as observer_last_run
  )
  select
    ps.latest_snapshot_at,
    ps.latest_kalshi_snapshot_at,
    ps.latest_polymarket_snapshot_at,
    ac.provider_markets_count,
    ac.snapshot_count,
    ec.families_count,
    ec.current_links_count,
    ec.observer_last_run
  from providers_summary ps
  cross join approx_counts ac
  cross join exact_counts ec
`;

export async function getRuntimeStatus(db) {
  const { rows } = await db.query(
    `select * from pmci.pmci_runtime_status where id = 1`
  );
  return rows[0] ?? null;
}

/**
 * Same aggregates as stored in pmci_runtime_status, without reading that table.
 * Use when the table row is missing (observer has not upserted yet).
 */
export async function computeLiveFreshnessSnapshot(db) {
  const { rows } = await db.query(RUNTIME_SNAPSHOT_SELECT);
  return rows[0] ?? null;
}

export async function updateRuntimeStatus(db) {
  const { rows } = await db.query(`
    insert into pmci.pmci_runtime_status (
      id,
      latest_snapshot_at,
      latest_kalshi_snapshot_at,
      latest_polymarket_snapshot_at,
      provider_markets_count,
      snapshot_count,
      families_count,
      current_links_count,
      observer_last_run,
      updated_at
    )
    select
      1,
      snap.latest_snapshot_at,
      snap.latest_kalshi_snapshot_at,
      snap.latest_polymarket_snapshot_at,
      snap.provider_markets_count,
      snap.snapshot_count,
      snap.families_count,
      snap.current_links_count,
      snap.observer_last_run,
      now()
    from (${RUNTIME_SNAPSHOT_SELECT}) snap
    on conflict (id)
    do update set
      latest_snapshot_at = excluded.latest_snapshot_at,
      latest_kalshi_snapshot_at = excluded.latest_kalshi_snapshot_at,
      latest_polymarket_snapshot_at = excluded.latest_polymarket_snapshot_at,
      provider_markets_count = excluded.provider_markets_count,
      snapshot_count = excluded.snapshot_count,
      families_count = excluded.families_count,
      current_links_count = excluded.current_links_count,
      observer_last_run = excluded.observer_last_run,
      updated_at = now()
    returning *;
  `);

  console.log('[pmci-runtime-status] updated runtime status');
  return rows[0] ?? null;
}

export async function refreshRuntimeStatus(db) {
  return updateRuntimeStatus(db);
}
