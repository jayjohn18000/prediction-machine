import { getCoverage, getCoverageSummary } from "../services/coverage-service.mjs";

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

    return getCoverage({
      query,
      resolveProviderIdByCode,
      SQL,
      providerCode: parsed.data.provider,
      category: parsed.data.category,
    });
  });

  app.get("/v1/coverage/summary", { rateLimit: RATE_LIMIT_CONFIG }, async (req) => {
    const schema = z.object({
      provider: z.string().min(1),
      category: z.string().min(1).optional(),
      since: z.string().optional(),
    });
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) return { error: parsed.error.flatten() };

    return getCoverageSummary({
      query,
      resolveProviderIdByCode,
      parseSince,
      SQL,
      providerCode: parsed.data.provider,
      category: parsed.data.category,
      since: parsed.data.since,
    });
  });
}
