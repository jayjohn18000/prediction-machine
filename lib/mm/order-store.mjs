/**
 * MM order/fill persistence (DATABASE_URL → service-role Postgres connections).
 */

import pg from "pg";

/**
 * @param {string}[connectionString]
 * @returns {import('pg').Client}
 */
export function createPgClient(connectionString = process.env.DATABASE_URL?.trim()) {
  if (!connectionString) throw new Error("order-store: DATABASE_URL is required");
  return new pg.Client({
    connectionString,
    ssl: connectionString.includes("amazonaws") || connectionString.includes("supabase.co")
      ? { rejectUnauthorized: false }
      : undefined,
  });
}

/**
 * Lookup pmci.provider_markets.id by Kalshi market ticker.
 *
 * @param {import('pg').Client | import('pg').PoolClient} client
 * @param {string} kalshiTicker
 * @returns {Promise<number|null>}
 */
export async function resolveKalshiMarketId(client, kalshiTicker) {
  const r = await client.query(
    `
    SELECT pm.id
    FROM pmci.provider_markets pm
    JOIN pmci.providers pr ON pm.provider_id = pr.id AND pr.code = 'kalshi'
    WHERE pm.provider_market_ref = $1
    LIMIT 1
    `,
    [kalshiTicker],
  );
  return r.rows[0]?.id ?? null;
}

/**
 * Insert mm_orders pending row prior to outbound Kalshi ACK.
 *
 * @param {import('pg').Client | import('pg').PoolClient} client
 * @param {object} row
 */
export async function insertMmOrderPending(client, row) {
  const q = `
    INSERT INTO pmci.mm_orders (
      market_id, client_order_id, side, price_cents, size_contracts, status,
      placed_at, fair_value_at_place, payload
    ) VALUES (
      $1,$2,$3,$4,$5,'pending',$6,$7,$8::jsonb
    )
    RETURNING *
  `;
  const params = [
    row.market_id,
    row.client_order_id,
    row.side,
    row.price_cents,
    row.size_contracts,
    row.placed_at ?? new Date(),
    row.fair_value_at_place ?? null,
    JSON.stringify(row.payload ?? {}),
  ];
  const r = await client.query(q, params);
  return r.rows[0];
}

/** @param {import('pg').Client | import('pg').PoolClient} client */
export async function findMmOrderByKalshiId(client, kalshi_order_id) {
  const r = await client.query(
    `SELECT * FROM pmci.mm_orders WHERE kalshi_order_id = $1 LIMIT 1`,
    [kalshi_order_id],
  );
  return r.rows[0] ?? null;
}

/** @param {import('pg').Client | import('pg').PoolClient} client */
export async function updateMmOrderFromKalshiResponse(client, { internalOrderPk, kalshi_order_id, status }) {
  const r = await client.query(
    `
    UPDATE pmci.mm_orders
    SET kalshi_order_id = COALESCE($2::text, kalshi_order_id),
        status = $3::text
    WHERE id = $1
    RETURNING *
    `,
    [internalOrderPk, kalshi_order_id, status],
  );
  return r.rows[0];
}

/**
 * Insert fill row. R8: fair_value_at_fill is copied from parent mm_orders.fair_value_at_place.
 * Idempotent on kalshi_fill_id when provided (duplicate insert returns unchanged via ON CONFLICT).
 *
 * @param {import('pg').Client | import('pg').PoolClient} client
 * @param {object} p
 */
export async function insertFill(client, p) {
  const fvRes = await client.query(
    `SELECT fair_value_at_place FROM pmci.mm_orders WHERE id = $1`,
    [p.order_pk],
  );
  const fvPlace = fvRes.rows[0]?.fair_value_at_place;
  const fairFill = fvPlace != null ? Number(fvPlace) : Number(p.fair_value_at_fill_fallback ?? NaN);
  if (!Number.isFinite(fairFill)) {
    throw new Error("insertFill R8: could not derive fair_value_at_fill from mm_orders");
  }

  if (p.kalshi_fill_id) {
    const ins = `
      INSERT INTO pmci.mm_fills (
        order_id, market_id, observed_at, price_cents, size_contracts, side,
        fair_value_at_fill, kalshi_fill_id
      )
      SELECT $1,$2,$3,$4,$5,$6,$7,$8
      WHERE NOT EXISTS (
        SELECT 1 FROM pmci.mm_fills WHERE kalshi_fill_id = $8
      )
      RETURNING *
    `;
    const r = await client.query(ins, [
      p.order_pk,
      p.market_id,
      p.observed_at,
      p.price_cents,
      p.size_contracts,
      p.side,
      fairFill,
      p.kalshi_fill_id,
    ]);
    return { inserted: r.rows.length > 0, row: r.rows[0] ?? (await lookupFill(client, p.kalshi_fill_id)), fair_value_at_fill: fairFill };
  }

  const r2 = await client.query(
    `
    INSERT INTO pmci.mm_fills (
      order_id, market_id, observed_at, price_cents, size_contracts, side,
      fair_value_at_fill
    ) VALUES ($1,$2,$3,$4,$5,$6,$7)
    RETURNING *
    `,
    [p.order_pk, p.market_id, p.observed_at, p.price_cents, p.size_contracts, p.side, fairFill],
  );
  return { inserted: true, row: r2.rows[0], fair_value_at_fill: fairFill };
}

/** @param {import('pg').Client | import('pg').PoolClient} client */
async function lookupFill(client, kalshiFillId) {
  const r = await client.query(`SELECT * FROM pmci.mm_fills WHERE kalshi_fill_id = $1`, [kalshiFillId]);
  return r.rows[0] ?? null;
}

/**
 * Working orders for one market — restart reconciliation vs Kalshi.
 *
 * @param {import('pg').Client | import('pg').PoolClient} client
 * @param {number|string} marketId
 */
export async function listWorkingMmOrdersForMarket(client, marketId) {
  const r = await client.query(
    `
    SELECT *
    FROM pmci.mm_orders
    WHERE market_id = $1
      AND status IN ('pending', 'open', 'partial')
    ORDER BY placed_at DESC
    `,
    [marketId],
  );
  return r.rows ?? [];
}

/** @param {import('pg').Client | import('pg').PoolClient} client */
export async function updateMmOrderStatus(client, internalOrderPk, status) {
  await client.query(`UPDATE pmci.mm_orders SET status = $2::text WHERE id = $1`, [
    internalOrderPk,
    status,
  ]);
}

/**
 * Terminal placement failure: merge kalshi_error into payload and set status rejected.
 *
 * @param {import('pg').Client | import('pg').PoolClient} client
 * @param {number|string} internalOrderPk
 * @param {object} kalshiErrorBlock JSON-serializable; stored under payload.kalshi_error
 */
export async function markMmOrderRejectedKalshi(client, internalOrderPk, kalshiErrorBlock) {
  await client.query(
    `
    UPDATE pmci.mm_orders
    SET status = 'rejected',
        payload = COALESCE(payload, '{}'::jsonb) || $2::jsonb
    WHERE id = $1::bigint
    `,
    [internalOrderPk, JSON.stringify({ kalshi_error: kalshiErrorBlock })],
  );
}

/**
 * Roll up mm_fills into parent mm_orders status + optional fill_* columns.
 *
 * @param {import('pg').Client | import('pg').PoolClient} client
 * @param {number|string} orderPk
 */
export async function syncMmOrderFillStateFromFills(client, orderPk) {
  const oRes = await client.query(
    `SELECT size_contracts::numeric AS sz FROM pmci.mm_orders WHERE id = $1::bigint`,
    [orderPk],
  );
  const orderSize = oRes.rows[0]?.sz != null ? Number(oRes.rows[0].sz) : 0;
  const fRes = await client.query(
    `
    SELECT
      COALESCE(SUM(size_contracts), 0)::numeric AS total_sz,
      MAX(observed_at) AS last_at,
      CASE WHEN COALESCE(SUM(size_contracts), 0) > 0 THEN
        ROUND(
          SUM(price_cents::numeric * size_contracts::numeric)
            / NULLIF(SUM(size_contracts::numeric), 0)
        )::int
      ELSE NULL END AS vwap_px
    FROM pmci.mm_fills
    WHERE order_id = $1::bigint
    `,
    [orderPk],
  );
  const fr = fRes.rows[0];
  const totalSz = fr?.total_sz != null ? Number(fr.total_sz) : 0;
  const vwap = fr?.vwap_px != null ? Number(fr.vwap_px) : null;
  const lastAt = fr?.last_at ?? null;

  const eps = 1e-9;
  let status = "open";
  if (orderSize > 0 && totalSz + eps >= orderSize) status = "filled";
  else if (totalSz > eps) status = "partial";

  await client.query(
    `
    UPDATE pmci.mm_orders SET
      status = $2::text,
      fill_size_contracts = CASE WHEN $3::numeric > 0 THEN $3::numeric ELSE NULL END,
      fill_price_cents = $4,
      filled_at = CASE WHEN $3::numeric > 0 THEN $5::timestamptz ELSE NULL END
    WHERE id = $1::bigint
    `,
    [orderPk, status, totalSz, vwap, lastAt],
  );
}
