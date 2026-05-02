/**
 * Post-fill mid backfill (W5) — reads `pmci.provider_market_depth` near fill time + offsets.
 * Populates post_fill_mid_1m / 5m / 30m and side-aware adverse_cents_5m (Contract R3/R8).
 */

/**
 * @param {string} side mm_fills.side
 * @returns {1|-1}
 */
export function computeSideSign(side) {
  const s = String(side ?? "");
  if (s === "yes_buy" || s === "no_sell") return 1;
  if (s === "yes_sell" || s === "no_buy") return -1;
  return 1;
}

/**
 * Closest `mid_cents` in depth within ±10s of `targetAt` (timestamptz).
 *
 * @param {import('pg').Client | import('pg').PoolClient} client
 * @param {number|string} providerMarketId `pmci.provider_markets.id` (= mm_fills.market_id)
 * @param {Date|string} targetAt
 * @returns {Promise<number|null>}
 */
export async function findClosestMidInWindow(client, providerMarketId, targetAt) {
  const r = await client.query(
    `
    SELECT mid_cents
    FROM pmci.provider_market_depth
    WHERE provider_market_id = $1::bigint
      AND observed_at >= ($2::timestamptz - interval '10 seconds')
      AND observed_at <= ($2::timestamptz + interval '10 seconds')
      AND mid_cents IS NOT NULL
    ORDER BY abs(extract(epoch from (observed_at - $2::timestamptz)))
    LIMIT 1
    `,
    [providerMarketId, targetAt],
  );
  const v = r.rows[0]?.mid_cents;
  return v != null && Number.isFinite(Number(v)) ? Number(v) : null;
}

/**
 * @typedef {'too_young' | 'already_present' | 'depth_missing'} BackfillSkipReason
 */

/**
 * @param {import('pg').Client | import('pg').PoolClient} client
 * @param {object} row mm_fills row
 * @param {'1m'|'5m'|'30m'} horizon
 * @param {Date} now
 * @returns {Promise<{ updated: boolean, skipped: boolean, skipReason: BackfillSkipReason | null }>}
 */
async function backfillOneHorizon(client, row, horizon, now) {
  const obs = new Date(row.observed_at);
  const offsetMin = horizon === "1m" ? 1 : horizon === "5m" ? 5 : 30;
  const minAgeMs = offsetMin * 60 * 1000;
  if (now.getTime() - obs.getTime() < minAgeMs) {
    return { updated: false, skipped: true, skipReason: "too_young" };
  }

  const col =
    horizon === "1m" ? "post_fill_mid_1m" : horizon === "5m" ? "post_fill_mid_5m" : "post_fill_mid_30m";
  if (row[col] != null && Number.isFinite(Number(row[col]))) {
    return { updated: false, skipped: true, skipReason: "already_present" };
  }

  const targetAt = new Date(obs.getTime() + minAgeMs);
  const mid = await findClosestMidInWindow(client, row.market_id, targetAt);
  if (mid == null) {
    console.log(
      `mm.backfill_skip fill_id=${row.id} market_id=${row.market_id} horizon=${horizon} target_at=${targetAt.toISOString()} reason=depth_missing`,
    );
    return { updated: false, skipped: true, skipReason: "depth_missing" };
  }

  if (horizon === "5m") {
    const fv = Number(row.fair_value_at_fill);
    const sign = computeSideSign(row.side);
    const adverse = sign * (mid - fv);
    await client.query(
      `
      UPDATE pmci.mm_fills
      SET post_fill_mid_5m = $2::numeric,
          adverse_cents_5m = $3::numeric
      WHERE id = $1::bigint
      `,
      [row.id, mid, adverse],
    );
  } else {
    await client.query(
      `
      UPDATE pmci.mm_fills
      SET ${horizon === "1m" ? "post_fill_mid_1m" : "post_fill_mid_30m"} = $2::numeric
      WHERE id = $1::bigint
      `,
      [row.id, mid],
    );
  }
  return { updated: true, skipped: false, skipReason: null };
}

/**
 * Backfill post-fill mids for eligible fills (7-day lookback, age gates per horizon).
 *
 * @param {{ client: import('pg').Client | import('pg').PoolClient, now?: Date }} p
 * @returns {Promise<{
 *   updated1m: number,
 *   updated5m: number,
 *   updated30m: number,
 *   skipped1m: number,
 *   skipped5m: number,
 *   skipped30m: number,
 *   skipReasons: { too_young: number, already_present: number, depth_missing: number }
 * }>}
 */
export async function backfillPostFillMids(p) {
  const { client } = p;
  const now = p.now ?? new Date();
  const stats = {
    updated1m: 0,
    updated5m: 0,
    updated30m: 0,
    skipped1m: 0,
    skipped5m: 0,
    skipped30m: 0,
    skipReasons: { too_young: 0, already_present: 0, depth_missing: 0 },
  };

  const list = await client.query(
    `
    SELECT id, market_id, observed_at, fair_value_at_fill, side,
           post_fill_mid_1m, post_fill_mid_5m, post_fill_mid_30m
    FROM pmci.mm_fills
    WHERE observed_at <= $1::timestamptz
      AND observed_at >= $1::timestamptz - interval '7 days'
      AND (
        (post_fill_mid_1m IS NULL AND observed_at <= $1::timestamptz - interval '1 minute')
        OR (post_fill_mid_5m IS NULL AND observed_at <= $1::timestamptz - interval '5 minutes')
        OR (post_fill_mid_30m IS NULL AND observed_at <= $1::timestamptz - interval '30 minutes')
      )
    ORDER BY observed_at ASC
    LIMIT 5000
    `,
    [now],
  );

  for (const row of list.rows) {
    /** @type {any} */
    const r = row;

    const r1 = await backfillOneHorizon(client, r, "1m", now);
    if (r1.updated) stats.updated1m += 1;
    if (r1.skipped) stats.skipped1m += 1;
    if (r1.skipReason) stats.skipReasons[r1.skipReason] += 1;

    const r5 = await backfillOneHorizon(client, r, "5m", now);
    if (r5.updated) stats.updated5m += 1;
    if (r5.skipped) stats.skipped5m += 1;
    if (r5.skipReason) stats.skipReasons[r5.skipReason] += 1;

    const r30 = await backfillOneHorizon(client, r, "30m", now);
    if (r30.updated) stats.updated30m += 1;
    if (r30.skipped) stats.skipped30m += 1;
    if (r30.skipReason) stats.skipReasons[r30.skipReason] += 1;
  }

  return stats;
}
