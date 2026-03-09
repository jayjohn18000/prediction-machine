import {
  listProviders,
  listCanonicalEvents,
  getUnlinkedMarkets,
  getNewMarkets,
} from "../services/markets-service.mjs";

/**
 * /v1/providers, /v1/canonical-events, /v1/markets/unlinked, /v1/markets/new routes.
 */
export function registerMarketsRoutes(app, deps) {
  const { query, resolveProviderIdByCode, SQL, RATE_LIMIT_CONFIG, parseSince, z } = deps;

  app.get("/v1/providers", { rateLimit: RATE_LIMIT_CONFIG }, async () => {
    return listProviders({ query, SQL });
  });

  app.get("/v1/canonical-events", { rateLimit: RATE_LIMIT_CONFIG }, async (req) => {
    const schema = z.object({ category: z.string().optional() });
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) return { error: parsed.error.flatten() };
    return listCanonicalEvents({ query, SQL, category: parsed.data.category });
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

    return getUnlinkedMarkets({
      query,
      resolveProviderIdByCode,
      parseSince,
      SQL,
      providerCode: parsed.data.provider,
      category: parsed.data.category,
      since: parsed.data.since,
      limit: parsed.data.limit,
    });
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

    return getNewMarkets({
      query,
      resolveProviderIdByCode,
      parseSince,
      SQL,
      providerCode: parsed.data.provider,
      category: parsed.data.category,
      since: parsed.data.since,
      limit: parsed.data.limit,
    });
  });
}
