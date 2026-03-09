import { getReviewQueue, applyReviewDecision, resolveLink } from "../services/review-service.mjs";

/**
 * /v1/review/queue, POST /v1/review/decision, POST /v1/resolve/link routes.
 */
export function registerReviewRoutes(app, deps) {
  const { query, withTransaction, resolveProviderIdByCode, SQL, RATE_LIMIT_CONFIG, z } = deps;

  app.get("/v1/review/queue", { rateLimit: RATE_LIMIT_CONFIG }, async (req) => {
    const schema = z.object({
      category: z.string().min(1).default("politics"),
      limit: z.coerce.number().int().min(1).max(100).default(1),
      min_confidence: z.coerce.number().min(0).max(1).default(0.88),
    });
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) return { error: parsed.error.flatten() };

    return getReviewQueue({
      query,
      SQL,
      category: parsed.data.category,
      minConfidence: parsed.data.min_confidence,
      limit: parsed.data.limit,
    });
  });

  app.post("/v1/review/decision", { rateLimit: RATE_LIMIT_CONFIG }, async (req) => {
    const schema = z.object({
      proposed_id: z.number().int().positive(),
      decision: z.enum(["accept", "reject", "skip"]),
      relationship_type: z.enum(["equivalent", "proxy"]),
      note: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return { error: parsed.error.flatten() };

    return applyReviewDecision({
      withTransaction,
      resolveProviderIdByCode,
      SQL,
      proposedId: parsed.data.proposed_id,
      decision: parsed.data.decision,
      relationshipType: parsed.data.relationship_type,
      note: parsed.data.note,
    });
  });

  app.post("/v1/resolve/link", { rateLimit: RATE_LIMIT_CONFIG }, async (req) => {
    const schema = z.object({
      family_id: z.number().int().positive(),
      provider_code: z.enum(["kalshi", "polymarket"]),
      provider_market_id: z.number().int().positive(),
      relationship_type: z.enum(["identical", "equivalent", "proxy", "correlated"]),
      confidence: z.number().min(0).max(1),
      reasons: z.record(z.any()).default({}),
      correlation_window: z.string().optional(),
      lag_seconds: z.number().int().optional(),
      correlation_strength: z.number().min(-1).max(1).optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return { error: parsed.error.flatten() };

    const adminKey = process.env.PMCI_ADMIN_KEY;
    if (adminKey && req.headers["x-pmci-admin-key"] !== adminKey) {
      return { error: "unauthorized" };
    }

    return resolveLink({
      withTransaction,
      resolveProviderIdByCode,
      SQL,
      familyId: parsed.data.family_id,
      providerCode: parsed.data.provider_code,
      providerMarketId: parsed.data.provider_market_id,
      relationshipType: parsed.data.relationship_type,
      confidence: parsed.data.confidence,
      reasons: parsed.data.reasons,
      correlationWindow: parsed.data.correlation_window,
      lagSeconds: parsed.data.lag_seconds,
      correlationStrength: parsed.data.correlation_strength,
    });
  });
}
