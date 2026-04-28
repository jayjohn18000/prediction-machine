/**
 * MM admin dashboard GET routes — requires `x-pmci-admin-key` (and global `x-pmci-api-key`).
 */
import { computeMarketPnl } from "../../lib/mm/pnl-attribution.mjs";

export function registerMmDashboardRoutes(app, deps) {
  const { query, PMCI_ADMIN_KEY, RATE_LIMIT_CONFIG, parseSince } = deps;

  function adminGate(req, reply, done) {
    if (!PMCI_ADMIN_KEY || req.headers["x-pmci-admin-key"] !== PMCI_ADMIN_KEY) {
      reply.code(403).send({ error: "forbidden", message: "admin key required" });
      return;
    }
    done();
  }

  const pre = [adminGate];

  app.get(
    "/v1/mm/markets",
    { preHandler: pre, rateLimit: RATE_LIMIT_CONFIG },
    async () => {
      const { rows } = await query(
        `
        SELECT c.*,
               pm.provider_market_ref AS kalshi_ticker,
               pm.title
        FROM pmci.mm_market_config c
        LEFT JOIN pmci.provider_markets pm ON pm.id = c.market_id
        ORDER BY c.market_id
        `,
      );
      return { markets: rows };
    },
  );

  app.get(
    "/v1/mm/positions",
    { preHandler: pre, rateLimit: RATE_LIMIT_CONFIG },
    async () => {
      const { rows } = await query(
        `
        SELECT p.*, pm.provider_market_ref AS kalshi_ticker
        FROM pmci.mm_positions p
        LEFT JOIN pmci.provider_markets pm ON pm.id = p.market_id
        ORDER BY p.market_id
        `,
      );
      return { positions: rows };
    },
  );

  app.get(
    "/v1/mm/pnl",
    { preHandler: pre, rateLimit: RATE_LIMIT_CONFIG },
    async (req) => {
      const marketId = req.query?.market_id;
      const since = parseSince(req.query?.since ?? "");

      if (marketId != null && String(marketId).length) {
        const mid = Number(marketId);
        const live = await computeMarketPnl({ query }, { marketId: mid });
        const snapRes = await query(
          since
            ? `SELECT * FROM pmci.mm_pnl_snapshots WHERE market_id = $1::bigint AND observed_at >= $2::timestamptz ORDER BY observed_at ASC`
            : `SELECT * FROM pmci.mm_pnl_snapshots WHERE market_id = $1::bigint ORDER BY observed_at DESC LIMIT 500`,
          since ? [mid, since.toISOString()] : [mid],
        );
        return { market_id: mid, live, snapshots: snapRes.rows };
      }

      const { rows } = await query(
        `
        SELECT DISTINCT ON (s.market_id) s.*
        FROM pmci.mm_pnl_snapshots s
        ORDER BY s.market_id, s.observed_at DESC
        `,
      );
      return { latest_per_market: rows };
    },
  );

  app.get(
    "/v1/mm/fills",
    { preHandler: pre, rateLimit: RATE_LIMIT_CONFIG },
    async (req) => {
      const marketId = req.query?.market_id;
      const since = parseSince(req.query?.since ?? "");
      const params = [];
      let where = "WHERE 1=1";
      if (marketId != null && String(marketId).length) {
        params.push(Number(marketId));
        where += ` AND f.market_id = $${params.length}::bigint`;
      }
      if (since) {
        params.push(since.toISOString());
        where += ` AND f.observed_at >= $${params.length}::timestamptz`;
      }
      const { rows } = await query(
        `
        SELECT f.*, pm.provider_market_ref AS kalshi_ticker
        FROM pmci.mm_fills f
        LEFT JOIN pmci.provider_markets pm ON pm.id = f.market_id
        ${where}
        ORDER BY f.observed_at DESC
        LIMIT 500
        `,
        params,
      );
      return { fills: rows };
    },
  );

  app.get(
    "/v1/mm/orders",
    { preHandler: pre, rateLimit: RATE_LIMIT_CONFIG },
    async (req) => {
      const status = req.query?.status;
      const marketId = req.query?.market_id;
      const params = [];
      let where = "WHERE 1=1";
      if (status != null && String(status).length) {
        params.push(String(status));
        where += ` AND o.status = $${params.length}::text`;
      }
      if (marketId != null && String(marketId).length) {
        params.push(Number(marketId));
        where += ` AND o.market_id = $${params.length}::bigint`;
      }
      const { rows } = await query(
        `
        SELECT o.*, pm.provider_market_ref AS kalshi_ticker
        FROM pmci.mm_orders o
        LEFT JOIN pmci.provider_markets pm ON pm.id = o.market_id
        ${where}
        ORDER BY o.placed_at DESC
        LIMIT 500
        `,
        params,
      );
      return { orders: rows };
    },
  );

  app.get(
    "/v1/mm/kill-switch-events",
    { preHandler: pre, rateLimit: RATE_LIMIT_CONFIG },
    async (req) => {
      const since = parseSince(req.query?.since ?? "");
      const params = [];
      let where = "WHERE 1=1";
      if (since) {
        params.push(since.toISOString());
        where += ` AND e.observed_at >= $${params.length}::timestamptz`;
      }
      const { rows } = await query(
        `
        SELECT e.*, pm.provider_market_ref AS kalshi_ticker
        FROM pmci.mm_kill_switch_events e
        LEFT JOIN pmci.provider_markets pm ON pm.id = e.market_id
        ${where}
        ORDER BY e.observed_at DESC
        LIMIT 500
        `,
        params,
      );
      return { events: rows };
    },
  );
}
