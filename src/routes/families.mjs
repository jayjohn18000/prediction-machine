/**
 * /v1/market-families and /v1/market-links routes.
 */
export function registerFamiliesRoutes(app, deps) {
  const { query, SQL, RATE_LIMIT_CONFIG, computeConsensus, computeDivergence, z } = deps;

  app.get("/v1/market-families", { rateLimit: RATE_LIMIT_CONFIG }, async (req) => {
    const schema = z.object({ event_id: z.string().uuid() });
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) return { error: parsed.error.flatten() };

    const { rows: families } = await query(SQL.families_by_event, [parsed.data.event_id]);
    if (families.length === 0) return [];

    const familyIds = families.map((f) => f.id);
    const { rows: allLinks } = await query(SQL.links_for_families_batch, [familyIds]);
    const allMarketIds = [...new Set(allLinks.map((l) => l.provider_market_id))];
    const { rows: snaps } = allMarketIds.length
      ? await query(SQL.latest_snapshots_for_markets, [allMarketIds])
      : { rows: [] };

    const latestByMarketId = new Map(snaps.map((s) => [s.provider_market_id, s]));
    const linksByFamily = new Map();
    for (const l of allLinks) {
      if (!linksByFamily.has(l.family_id)) linksByFamily.set(l.family_id, []);
      linksByFamily.get(l.family_id).push(l);
    }

    return families.map((f) => {
      const links = linksByFamily.get(f.id) ?? [];
      const consensus = computeConsensus(links, latestByMarketId);
      return {
        id: Number(f.id),
        canonical_event_id: f.canonical_event_id,
        canonical_market_id: f.canonical_market_id,
        label: f.label,
        consensus_price: consensus,
        num_links: links.length,
      };
    });
  });

  app.get("/v1/market-links", { rateLimit: RATE_LIMIT_CONFIG }, async (req) => {
    const schema = z.object({ family_id: z.coerce.number().int().positive() });
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) return { error: parsed.error.flatten() };

    const { rows: links } = await query(SQL.current_links_for_family, [parsed.data.family_id]);
    const marketIds = links.map((l) => l.provider_market_id);
    const { rows: snaps } = await query(SQL.latest_snapshots_for_markets, [marketIds]);

    const latest = new Map(snaps.map((s) => [s.provider_market_id, s]));
    const consensus = computeConsensus(links, latest);

    return links.map((l) => {
      const snap = latest.get(l.provider_market_id);
      const price = snap?.price_yes ?? null;
      return {
        id: Number(l.id),
        family_id: Number(l.family_id),
        provider: l.provider,
        provider_market_id: Number(l.provider_market_id),
        provider_market_ref: l.provider_market_ref,
        relationship_type: l.relationship_type,
        status: l.status,
        link_version: Number(l.link_version),
        confidence: Number(l.confidence),
        price,
        consensus_price: consensus,
        divergence: computeDivergence(price, consensus),
        correlation_window: l.correlation_window,
        lag_seconds: l.lag_seconds == null ? null : Number(l.lag_seconds),
        correlation_strength: l.correlation_strength == null ? null : Number(l.correlation_strength),
        break_rate: l.break_rate == null ? null : Number(l.break_rate),
        last_validated_at: l.last_validated_at,
        staleness_score: l.staleness_score == null ? null : Number(l.staleness_score),
        reasons: l.reasons ?? {},
        market_title: l.market_title,
      };
    });
  });
}
