/**
 * Live snapshot of PMCI freshness (latest snapshot times + row counts).
 * Matches the shape read from pmci.pmci_runtime_status for the same logical fields.
 */
const RUNTIME_SNAPSHOT_SELECT = `
  with latest_snapshots as (
    select
      max(s.observed_at) as latest_snapshot_at,
      max(s.observed_at) filter (where p.code = 'kalshi') as latest_kalshi_snapshot_at,
      max(s.observed_at) filter (where p.code = 'polymarket') as latest_polymarket_snapshot_at
    from pmci.provider_market_snapshots s
    join pmci.provider_markets pm on pm.id = s.provider_market_id
    join pmci.providers p on p.id = pm.provider_id
  ),
  counts as (
    select
      (select count(*)::int from pmci.provider_markets) as provider_markets_count,
      (select count(*)::int from pmci.provider_market_snapshots) as snapshot_count,
      (select count(*)::int from pmci.market_families) as families_count,
      (select count(*)::int from pmci.v_market_links_current) as current_links_count,
      (select max(cycle_at) from pmci.observer_heartbeats) as observer_last_run
  )
  select
    ls.latest_snapshot_at,
    ls.latest_kalshi_snapshot_at,
    ls.latest_polymarket_snapshot_at,
    c.provider_markets_count,
    c.snapshot_count,
    c.families_count,
    c.current_links_count,
    c.observer_last_run
  from latest_snapshots ls
  cross join counts c
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
