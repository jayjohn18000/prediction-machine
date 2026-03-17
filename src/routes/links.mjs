/**
 * GET /v1/links — historical and current link query across all statuses.
 *
 * Query params:
 *   status   "active" | "removed" | "any"  (default: "active")
 *   topic    category string, e.g. "politics"  (optional)
 *   after    ISO-8601 timestamptz  (optional, filters on created_at)
 *   limit    1–200  (default 50)
 *   offset   integer  (default 0)
 */
export function registerLinksRoutes(app, deps) {
  const { query, SQL, RATE_LIMIT_CONFIG, z } = deps;

  const querySchema = z.object({
    status: z.enum(["active", "removed", "any"]).default("active"),
    topic: z.string().min(1).optional(),
    after: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  });

  app.get("/v1/links", { rateLimit: RATE_LIMIT_CONFIG }, async (req) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return { error: "invalid_params", detail: parsed.error.flatten() };
    }

    const { status, topic, after, limit, offset } = parsed.data;

    // null → SQL treats as "no filter" via $n::text is null check
    const statusParam = status === "any" ? null : status;
    const topicParam = topic ?? null;
    const afterParam = after ?? null;

    const [{ rows: links }, { rows: countRows }] = await Promise.all([
      query(SQL.links_history, [statusParam, topicParam, afterParam, limit, offset]),
      query(SQL.links_history_count, [statusParam, topicParam, afterParam]),
    ]);

    return {
      links: links.map((l) => ({
        id: Number(l.id),
        family_id: Number(l.family_id),
        provider_market_id: Number(l.provider_market_id),
        provider: l.provider,
        provider_market_ref: l.provider_market_ref,
        market_title: l.market_title,
        event_slug: l.event_slug,
        category: l.category,
        status: l.status,
        relationship_type: l.relationship_type,
        link_version: Number(l.link_version),
        confidence: Number(l.confidence),
        reasons: l.reasons ?? {},
        removed_at: l.removed_at ?? null,
        removed_reason: l.removed_reason ?? null,
        created_at: l.created_at,
        updated_at: l.updated_at,
      })),
      total: countRows[0]?.total ?? 0,
      limit,
      offset,
      filters: { status, topic: topic ?? null, after: after ?? null },
    };
  });
}
