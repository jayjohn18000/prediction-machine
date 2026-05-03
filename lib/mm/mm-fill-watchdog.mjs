/**
 * Rolling fill / reject watchdog — audit-only rows in mm_kill_switch_events (no kill flag).
 */

import { appendMmOperationalEvent } from "./risk.mjs";

/** Min accepted orders in 4h window before fill-rate floor is meaningful. */
const MIN_ORDERS_FOR_FILL_RATE = 50;
/** Min accepted orders in 1h window before reject-rate storm is meaningful. */
const MIN_ORDERS_FOR_REJECT_RATE = 20;
/** Cooldown between repeated audit rows per (ticker, reason). */
const WATCHDOG_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * @param {import('pg').Client | import('pg').PoolClient} client
 * @param {number[]} marketIds
 */
export async function fetchMmWatchdogStats(client, marketIds) {
  if (!marketIds.length) return [];
  const r = await client.query(
    `
    WITH ids AS (SELECT unnest($1::bigint[]) AS market_id)
    SELECT
      ids.market_id,
      (SELECT count(*)::int FROM pmci.mm_orders o WHERE o.market_id = ids.market_id AND o.placed_at >= now() - interval '4 hours') AS orders_4h,
      (SELECT count(*)::int FROM pmci.mm_fills f WHERE f.market_id = ids.market_id AND f.observed_at >= now() - interval '4 hours') AS fills_4h,
      (SELECT count(*)::int FROM pmci.mm_orders o WHERE o.market_id = ids.market_id AND o.placed_at >= now() - interval '1 hour') AS orders_1h,
      (SELECT count(*)::int FROM pmci.mm_orders o WHERE o.market_id = ids.market_id AND o.placed_at >= now() - interval '1 hour' AND o.status = 'rejected') AS rejects_1h
    FROM ids
    `,
    [marketIds],
  );
  return r.rows ?? [];
}

/**
 * @param {object[]} statRows fetchMmWatchdogStats output
 * @param {Record<string, string>} marketIdToTicker
 */
export function evaluateMmWatchdogAlerts(statRows, marketIdToTicker) {
  /** @type {{ marketId: string|number, ticker: string, reason: string, details: object }[]} */
  const alerts = [];
  for (const row of statRows) {
    const mid = String(row.market_id);
    const ticker = marketIdToTicker[mid] ?? mid;
    const o4 = Number(row.orders_4h) || 0;
    const f4 = Number(row.fills_4h) || 0;
    const o1 = Number(row.orders_1h) || 0;
    const r1 = Number(row.rejects_1h) || 0;
    if (o4 >= MIN_ORDERS_FOR_FILL_RATE) {
      const fr = f4 / o4;
      if (fr < 0.0005) {
        alerts.push({
          marketId: row.market_id,
          ticker,
          reason: "fill_rate_floor",
          details: { fills_4h: f4, orders_4h: o4, fill_rate: fr },
        });
      }
    }
    if (o1 >= MIN_ORDERS_FOR_REJECT_RATE) {
      const rr = r1 / o1;
      if (rr > 0.5) {
        alerts.push({
          marketId: row.market_id,
          ticker,
          reason: "reject_storm",
          details: { rejects_1h: r1, orders_1h: o1, reject_rate: rr },
        });
      }
    }
  }
  return alerts;
}

/**
 * @param {object} p
 * @param {import('pg').Client | import('pg').PoolClient} p.client
 * @param {Record<string, unknown>} p.health
 * @param {Array<{ market_id: unknown, kalshi_ticker: string }>} p.markets
 */
export async function runMmFillWatchdogTick(p) {
  const { client, health, markets } = p;
  const h = /** @type {any} */ (health);
  const mids = markets.map((r) => Number(r.market_id));
  /** @type {Record<string, string>} */
  const idToTicker = {};
  for (const r of markets) idToTicker[String(r.market_id)] = String(r.kalshi_ticker);

  const stats = await fetchMmWatchdogStats(client, mids);
  const alerts = evaluateMmWatchdogAlerts(stats, idToTicker);
  h.mmWatchdogActiveAlerts = alerts;

  const last = /** @type {Record<string, number>} */ (h.mmWatchdogCooldown ?? {});
  const now = Date.now();
  /** @type {typeof alerts} */
  const fired = [];

  for (const a of alerts) {
    const key = `${a.ticker}:${a.reason}`;
    if (last[key] != null && now - last[key] < WATCHDOG_COOLDOWN_MS) continue;
    last[key] = now;
    try {
      await appendMmOperationalEvent(client, {
        marketId: a.marketId,
        reason: a.reason,
        details: { ticker: a.ticker, ...a.details, observed_at: new Date().toISOString() },
      });
    } catch {
      /* non-fatal */
    }
    fired.push(a);
  }
  h.mmWatchdogCooldown = last;
  h.mmWatchdogAlerts = fired;
  return fired;
}