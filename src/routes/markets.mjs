/**
 * /v1/providers, /v1/canonical-events, /v1/markets/unlinked, /v1/markets/new routes.
 */
export function registerMarketsRoutes(app, deps) {
  const { query, resolveProviderIdByCode, SQL, RATE_LIMIT_CONFIG, parseSince, z } = deps;

  app.get("/v1/providers", { rateLimit: RATE_LIMIT_CONFIG }, async () => {
    const { rows } = await query(SQL.providers);
    return rows.map((r) => ({ code: r.code, name: r.name }));
  });

  app.get("/v1/canonical-events", { rateLimit: RATE_LIMIT_CONFIG }, async (req) => {
    const schema = z.object({ category: z.string().optional() });
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) return { error: parsed.error.flatten() };
    const { rows } = await query(SQL.canonical_events, [parsed.data.category ?? null]);
    return rows;
  });

  app.get("/v1/markets/unlinked", { rateLimit: RATE_LIMIT_CONFIG }, async (req) => {
    const schema = z.object({
      provider: z.string().min(1),
      category: z.string().min(1).optional(),
      since: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(20),
    });
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) return { error: parsed.error.flatten() };

    const providerId = await resolveProviderIdByCode(query, parsed.data.provider);
    if (providerId == null) return { error: "unknown_provider" };

    const category = parsed.data.category ?? null;
    const sinceDate = parseSince(parsed.data.since);
    const sinceTs = sinceDate ? sinceDate.toISOString() : null;

    const { rows } = await query(SQL.unlinked_markets, [
      providerId,
      category,
      sinceTs,
      parsed.data.limit,
    ]);

    return rows.map((r) => ({
      provider: parsed.data.provider,
      provider_market_id: Number(r.provider_market_id),
      provider_market_ref: r.provider_market_ref,
      title: r.title,
      category: r.category,
      status: r.status,
      first_seen_at: r.first_seen_at,
      last_seen_at: r.last_seen_at,
      url: r.url ?? undefined,
    }));
  });

  app.get("/v1/markets/new", { rateLimit: RATE_LIMIT_CONFIG }, async (req) => {
    const schema = z.object({
      provider: z.string().min(1),
      category: z.string().min(1).optional(),
      since: z.string().min(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
    });
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) return { error: parsed.error.flatten() };

    const sinceDate = parseSince(parsed.data.since);
    if (!sinceDate)
      return { error: "invalid_since", message: "since must be ISO date or relative e.g. 24h, 7d" };

    const providerId = await resolveProviderIdByCode(query, parsed.data.provider);
    if (providerId == null) return { error: "unknown_provider" };

    const category = parsed.data.category ?? null;
    const sinceTs = sinceDate.toISOString();

    const { rows } = await query(SQL.new_markets, [
      providerId,
      category,
      sinceTs,
      parsed.data.limit,
    ]);

    return rows.map((r) => ({
      provider: parsed.data.provider,
      provider_market_id: Number(r.provider_market_id),
      provider_market_ref: r.provider_market_ref,
      title: r.title,
      category: r.category,
      status: r.status,
      first_seen_at: r.first_seen_at,
      last_seen_at: r.last_seen_at,
      url: r.url ?? undefined,
    }));
  });
}
