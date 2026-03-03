/**
 * SQL helpers for PMCI v1 endpoints.
 * Assumes schema prefix `pmci`.
 */
export const SQL = {
  providers: `
    select id, code, name
    from pmci.providers
    order by id asc;
  `,

  coverage: `
    with pm as (
      select pm.id, pm.provider_id
      from pmci.provider_markets pm
      where pm.provider_id = $1
        and ($2::text is null or pm.category = $2)
    ),
    matched as (
      select distinct l.provider_market_id
      from pmci.v_market_links_current l
      join pm on pm.id = l.provider_market_id
      where l.status = 'active'
    ),
    unmatched as (
      select um.reason, count(*)::int as count
      from pmci.unmatched_markets um
      join pm on pm.id = um.provider_market_id
      where um.provider_id = $1
        and um.active = true
      group by um.reason
      order by count desc
    )
    select
      (select count(*)::int from pm) as total_markets,
      (select count(*)::int from matched) as matched_markets,
      case when (select count(*) from pm) = 0 then 0
           else (select count(*)::numeric from matched) / (select count(*)::numeric from pm)
      end as coverage_ratio,
      coalesce((select jsonb_agg(jsonb_build_object('reason', reason, 'count', count)) from unmatched), '[]'::jsonb) as unmatched_breakdown;
  `,

  families_by_event: `
    select id, canonical_event_id, canonical_market_id, label
    from pmci.market_families
    where canonical_event_id = $1
    order by id asc;
  `,

  latest_snapshots_for_markets: `
    select distinct on (s.provider_market_id)
      s.provider_market_id,
      s.observed_at,
      s.price_yes,
      s.liquidity,
      s.best_bid_yes,
      s.best_ask_yes
    from pmci.provider_market_snapshots s
    where s.provider_market_id = any($1::bigint[])
    order by s.provider_market_id, s.observed_at desc;
  `,

  current_links_for_family: `
    select
      l.id,
      l.family_id,
      p.code as provider,
      l.provider_id,
      l.provider_market_id,
      l.relationship_type,
      l.status,
      l.link_version,
      l.confidence,
      l.correlation_window,
      l.lag_seconds,
      l.correlation_strength,
      l.break_rate,
      l.last_validated_at,
      l.staleness_score,
      l.reasons,
      pm.title as market_title,
      pm.provider_market_ref as provider_market_ref
    from pmci.v_market_links_current l
    join pmci.providers p on p.id = l.provider_id
    join pmci.provider_markets pm on pm.id = l.provider_market_id
    where l.family_id = $1
    order by l.relationship_type, l.confidence desc;
  `,

  next_linker_run_version: `
    select coalesce(max(version), 0) + 1 as next_version
    from pmci.linker_runs;
  `,

  insert_linker_run: `
    insert into pmci.linker_runs (version, description)
    values ($1, $2)
    returning id, version;
  `,

  coverage_summary: `
    with pm as (
      select pm.id
      from pmci.provider_markets pm
      where pm.provider_id = $1
        and ($2::text is null or pm.category = $2)
        and ($3::timestamptz is null or pm.last_seen_at >= $3)
    ),
    linked as (
      select distinct l.provider_market_id
      from pmci.v_market_links_current l
      join pm on pm.id = l.provider_market_id
      where l.status = 'active'
    )
    select
      (select count(*)::int from pm) as total_markets,
      (select count(*)::int from linked) as linked_markets,
      (select count(*)::int from pm) - (select count(*)::int from linked) as unlinked_markets,
      case when (select count(*) from pm) = 0 then 0
           else (select count(*)::numeric from linked) / (select count(*)::numeric from pm)
      end as coverage_ratio;
  `,

  unlinked_markets: `
    with pm as (
      select pm.id, pm.provider_market_ref, pm.title, pm.category, pm.status, pm.url, pm.first_seen_at, pm.last_seen_at
      from pmci.provider_markets pm
      where pm.provider_id = $1
        and ($2::text is null or pm.category = $2)
        and ($3::timestamptz is null or pm.last_seen_at >= $3)
    ),
    linked as (
      select distinct l.provider_market_id from pmci.v_market_links_current l where l.status = 'active'
    )
    select pm.id as provider_market_id, pm.provider_market_ref, pm.title, pm.category, pm.status, pm.url, pm.first_seen_at, pm.last_seen_at
    from pm
    left join linked l on l.provider_market_id = pm.id
    where l.provider_market_id is null
    order by pm.last_seen_at desc nulls last, pm.id desc
    limit $4;
  `,

  new_markets: `
    select pm.id as provider_market_id, pm.provider_market_ref, pm.title, pm.category, pm.status, pm.url, pm.first_seen_at, pm.last_seen_at
    from pmci.provider_markets pm
    where pm.provider_id = $1
      and ($2::text is null or pm.category = $2)
      and pm.first_seen_at >= $3
    order by pm.first_seen_at desc, pm.id desc
    limit $4;
  `,

  review_queue: `
    select
      p.id as proposed_id,
      p.provider_market_id_a,
      p.provider_market_id_b,
      p.proposed_relationship_type,
      p.confidence,
      p.reasons,
      p.created_at,
      pa.provider_id as provider_id_a,
      pr_a.code as provider_code_a,
      pa.provider_market_ref as ref_a,
      pa.title as title_a,
      pa.category as category_a,
      pa.status as status_a,
      pa.url as url_a,
      pa.close_time as close_time_a,
      pb.provider_id as provider_id_b,
      pr_b.code as provider_code_b,
      pb.provider_market_ref as ref_b,
      pb.title as title_b,
      pb.category as category_b,
      pb.status as status_b,
      pb.url as url_b,
      pb.close_time as close_time_b
    from pmci.proposed_links p
    join pmci.provider_markets pa on pa.id = p.provider_market_id_a
    join pmci.providers pr_a on pr_a.id = pa.provider_id
    join pmci.provider_markets pb on pb.id = p.provider_market_id_b
    join pmci.providers pr_b on pr_b.id = pb.provider_id
    where p.category = $1
      and p.decision is null
      and p.confidence >= $2
    order by p.confidence desc, p.created_at asc
    limit $3;
  `,

  latest_snapshots_with_raw: `
    select distinct on (s.provider_market_id)
      s.provider_market_id,
      s.observed_at,
      s.price_yes,
      s.raw
    from pmci.provider_market_snapshots s
    where s.provider_market_id = any($1::bigint[])
    order by s.provider_market_id, s.observed_at desc;
  `,

  observer_health: `
    select cycle_at, pairs_attempted, pairs_succeeded, pairs_configured,
      kalshi_fetch_errors, polymarket_fetch_errors,
      spread_insert_errors, pmci_ingestion_errors, json_parse_errors
    from pmci.observer_heartbeats
    order by cycle_at desc limit 20
  `,

  canonical_events: `
    select id, slug, title, category, start_time, end_time, metadata, created_at
    from pmci.canonical_events
    where ($1::text is null or category = $1)
    order by created_at desc
  `,

  insert_market_link: `
    insert into pmci.market_links (
      family_id, provider_id, provider_market_id, relationship_type, status,
      link_version, confidence,
      correlation_window, lag_seconds, correlation_strength,
      break_rate, last_validated_at, staleness_score,
      reasons
    ) values (
      $1, $2, $3, $4, $5,
      $6, $7,
      $8, $9, $10,
      $11, $12, $13,
      $14::jsonb
    )
    returning id, family_id, link_version, status;
  `,
};
