export async function getTopDivergences(db, eventId, limit, category = null, canonicalEventSlug = null) {
  const params = [];
  const conditions = [];

  if (eventId) {
    params.push(eventId);
    conditions.push(`f.canonical_event_id = $${params.length}`);
  }
  if (canonicalEventSlug) {
    params.push(canonicalEventSlug);
    conditions.push(`ce.slug = $${params.length}`);
  }
  if (category) {
    params.push(category);
    conditions.push(`ce.category = $${params.length}`);
  }

  const ceJoin = category || canonicalEventSlug
    ? "join pmci.canonical_events ce on ce.id = f.canonical_event_id"
    : "";

  const whereClause = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";

  params.push(limit);
  const limitParam = `$${params.length}`;

  const sql = `
    with latest_snapshots as (
      select distinct on (s.provider_market_id)
        s.provider_market_id,
        s.observed_at,
        s.price_yes,
        s.liquidity,
        s.best_bid_yes,
        s.best_ask_yes
      from pmci.provider_market_snapshots s
      order by s.provider_market_id, s.observed_at desc
    ),
    family_markets as (
      select
        f.id as family_id,
        f.canonical_event_id as event_id,
        f.label,
        l.id as link_id,
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
        pm.provider_market_ref,
        ls.observed_at,
        ls.price_yes,
        ls.liquidity,
        ls.best_bid_yes,
        ls.best_ask_yes,
        case l.relationship_type
          when 'identical' then 1.0
          when 'equivalent' then 1.0
          when 'proxy' then 0.5
          when 'correlated' then 0.25
          else 0.25
        end as relationship_weight
      from pmci.market_families f
      join pmci.v_market_links_current l
        on l.family_id = f.id
      join pmci.providers p
        on p.id = l.provider_id
      join pmci.provider_markets pm
        on pm.id = l.provider_market_id
      ${ceJoin}
      left join latest_snapshots ls
        on ls.provider_market_id = l.provider_market_id
      ${whereClause}
    ),
    scored as (
      select
        fm.*,
        case
          when fm.status = 'active' and fm.price_yes is not null
          then coalesce(fm.liquidity, 1)::numeric * fm.confidence::numeric * fm.relationship_weight::numeric
          else null
        end as market_weight,
        (
          sum(
            case
              when fm.status = 'active' and fm.price_yes is not null
              then (coalesce(fm.liquidity, 1)::numeric * fm.confidence::numeric * fm.relationship_weight::numeric) * fm.price_yes::numeric
              else null
            end
          ) over (partition by fm.family_id)
          /
          nullif(
            sum(
              case
                when fm.status = 'active' and fm.price_yes is not null
                then coalesce(fm.liquidity, 1)::numeric * fm.confidence::numeric * fm.relationship_weight::numeric
                else null
              end
            ) over (partition by fm.family_id),
            0
          )
        ) as consensus_price
      from family_markets fm
    ),
    ranked as (
      select
        s.*,
        case
          when s.price_yes is null or s.consensus_price is null then null
          else abs(s.price_yes::numeric - s.consensus_price)
        end as divergence,
        max(s.observed_at) over (partition by s.family_id) as last_observed_at
      from scored s
    ),
    ranked_families as (
      select
        r.*,
        max(r.divergence) over (partition by r.family_id) as max_divergence
      from ranked r
    ),
    top_families as (
      select family_id, max(max_divergence) as family_max_divergence
      from ranked_families
      group by family_id
      order by family_max_divergence desc nulls last, family_id asc
      limit ${limitParam}
    )
    select
      rf.family_id,
      rf.event_id,
      rf.label,
      rf.link_id,
      rf.provider,
      rf.provider_id,
      rf.provider_market_id,
      rf.provider_market_ref,
      rf.market_title,
      rf.relationship_type,
      rf.status,
      rf.link_version,
      rf.confidence,
      rf.correlation_window,
      rf.lag_seconds,
      rf.correlation_strength,
      rf.break_rate,
      rf.last_validated_at,
      rf.staleness_score,
      rf.reasons,
      rf.observed_at,
      rf.price_yes,
      rf.liquidity,
      rf.best_bid_yes,
      rf.best_ask_yes,
      rf.consensus_price,
      rf.divergence,
      rf.max_divergence,
      rf.last_observed_at
    from ranked_families rf
    join top_families tf
      on tf.family_id = rf.family_id
    order by tf.family_max_divergence desc nulls last, rf.family_id asc, rf.relationship_type asc, rf.confidence desc;
  `;

  const { rows } = await db.query(sql, params);

  const families = [];
  const byFamilyId = new Map();

  for (const row of rows) {
    const familyId = Number(row.family_id);
    let family = byFamilyId.get(familyId);

    if (!family) {
      family = {
        family_id: familyId,
        label: row.label,
        consensus_price: row.consensus_price == null ? null : Number(row.consensus_price),
        max_divergence: row.max_divergence == null ? null : Number(row.max_divergence),
        last_observed_at: row.last_observed_at ?? null,
        legs: [],
      };
      byFamilyId.set(familyId, family);
      families.push(family);
    }

    family.legs.push({
      provider: row.provider,
      provider_market_id: Number(row.provider_market_id),
      provider_market_ref: row.provider_market_ref,
      price_yes: row.price_yes == null ? null : Number(row.price_yes),
      divergence: row.divergence == null ? null : Number(row.divergence),
      relationship_type: row.relationship_type,
      confidence: row.confidence == null ? null : Number(row.confidence),
    });
  }

  return families;
}
