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
