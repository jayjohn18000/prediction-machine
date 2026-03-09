/**
 * /v1/coverage and /v1/coverage/summary routes.
 */
export function registerCoverageRoutes(app, deps) {
  const { query, resolveProviderIdByCode, SQL, RATE_LIMIT_CONFIG, parseSince, z } = deps;

  app.get("/v1/coverage", { rateLimit: RATE_LIMIT_CONFIG }, async (req) => {
    const schema = z.object({
      provider: z.string().min(1),
      category: z.string().min(1).optional(),
    });
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) return { error: parsed.error.flatten() };

    const providerId = await resolveProviderIdByCode(query, parsed.data.provider);
    if (providerId == null) return { error: "unknown_provider" };

    const category = parsed.data.category ?? null;
    const cov = await query(SQL.coverage, [providerId, category]);
    const row = cov.rows[0];

    return {
      provider: parsed.data.provider,
      category,
      total_markets: Number(row.total_markets),
      matched_markets: Number(row.matched_markets),
      coverage_ratio: Number(row.coverage_ratio),
      unmatched_breakdown: row.unmatched_breakdown ?? [],
    };
  });

  app.get("/v1/coverage/summary", { rateLimit: RATE_LIMIT_CONFIG }, async (req) => {
    const schema = z.object({
      provider: z.string().min(1),
      category: z.string().min(1).optional(),
      since: z.string().optional(),
    });
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) return { error: parsed.error.flatten() };

    const providerId = await resolveProviderIdByCode(query, parsed.data.provider);
    if (providerId == null) return { error: "unknown_provider" };

    const category = parsed.data.category ?? null;
    const sinceDate = parseSince(parsed.data.since);
    const sinceTs = sinceDate ? sinceDate.toISOString() : null;

    const { rows } = await query(SQL.coverage_summary, [providerId, category, sinceTs]);
    const row = rows[0];

    return {
      provider: parsed.data.provider,
      category: category ?? undefined,
      since: parsed.data.since ?? undefined,
      total_markets: Number(row.total_markets),
      linked_markets: Number(row.linked_markets),
      unlinked_markets: Number(row.unlinked_markets),
      coverage_ratio: Number(row.coverage_ratio),
    };
  });
}
