/**
 * /v1/signals/divergence, /v1/signals/top-divergences, and /v1/snapshots routes.
 */
import { getTopDivergences } from "../services/signal-queries.mjs";

// Maps API interval param → postgres date_trunc field (whitelist prevents injection)
const INTERVAL_MAP = { "1h": "hour", "1d": "day" };

// Maps API since param → postgres interval string
function parseSinceInterval(since) {
  const m = /^(\d+)(h|d)$/.exec(since);
  if (!m) return null;
  const [, n, unit] = m;
  return unit === "h" ? `${n} hours` : `${n} days`;
}

export function registerSignalsRoutes(app, deps) {
  const { query, SQL, assertFreshness, RATE_LIMIT_CONFIG, z } = deps;

  app.get("/v1/signals/divergence", { preHandler: assertFreshness, rateLimit: RATE_LIMIT_CONFIG }, async (req) => {
    const schema = z.object({ family_id: z.coerce.number().int().positive() });
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) return { error: parsed.error.flatten() };

    const resp = await deps.app.inject({ method: "GET", url: `/v1/market-links?family_id=${parsed.data.family_id}` });
    const rows = resp.json();
    if (rows?.error) return rows;

    return rows
      .filter((r) => r.divergence != null)
      .sort((a, b) => Number(b.divergence) - Number(a.divergence))
      .map((r) => ({
        family_id: r.family_id,
        provider: r.provider,
        provider_market_id: r.provider_market_id,
        relationship_type: r.relationship_type,
        price: r.price,
        consensus_price: r.consensus_price,
        divergence: r.divergence,
      }));
  });

  app.get("/v1/signals/top-divergences", { preHandler: assertFreshness, rateLimit: RATE_LIMIT_CONFIG }, async (req) => {
    const schema = z.object({
      event_id: z.string().uuid(),
      limit: z.coerce.number().int().min(1).max(100).default(20),
    });
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) return { error: parsed.error.flatten() };

    return getTopDivergences({ query }, parsed.data.event_id, parsed.data.limit);
  });

  app.get("/v1/snapshots", { rateLimit: RATE_LIMIT_CONFIG }, async (req, reply) => {
    const schema = z.object({
      family_id: z.coerce.number().int().positive(),
      since: z.string().regex(/^\d+(h|d)$/).default("7d"),
      interval: z.enum(["1h", "1d"]).default("1h"),
    });
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: parsed.error.flatten() };
    }

    const { family_id, since, interval } = parsed.data;
    const truncField = INTERVAL_MAP[interval];
    const pgInterval = parseSinceInterval(since);

    const { rows } = await query(SQL.snapshot_history, [family_id, truncField, pgInterval]);

    // Group rows by provider → series
    const byProvider = new Map();
    for (const row of rows) {
      if (!byProvider.has(row.provider)) byProvider.set(row.provider, []);
      byProvider.get(row.provider).push({
        bucket: row.bucket,
        price_yes: Number(row.price_yes_avg),
      });
    }

    return {
      family_id,
      interval,
      since,
      providers: [...byProvider.entries()].map(([provider, series]) => ({ provider, series })),
    };
  });
}
