#!/usr/bin/env node
/**
 * MM rotator companion: disable stale / toxic tickers without orchestrator restart.
 * Orchestrator picks up mm_market_config.enabled on its next refresh.
 *
 * Env: DATABASE_URL (required when run standalone).
 */
import "dotenv/config";
import { createPgClient } from "../../lib/mm/order-store.mjs";

/**
 * @param {{ client?: import('pg').Client, logger?: { info?: (s: string) => void, warn?: (s: string) => void } }} [opts]
 */
export async function runRotatorDisableWatcher(opts = {}) {
  const logger = opts.logger ?? console;
  const client = opts.client ?? createPgClient();
  const ownsClient = opts.client == null;
  if (ownsClient) await client.connect();

  /** @type {{ ok: boolean, closed_disabled: number, reject_storm_disabled: number, blocklist_1h_rows: number, blocklist_24h_rows: number, kill_switch_disabled: number, error?: string, finished_at?: string }} */
  const summary = {
    ok: true,
    closed_disabled: 0,
    reject_storm_disabled: 0,
    blocklist_1h_rows: 0,
    blocklist_24h_rows: 0,
    kill_switch_disabled: 0,
  };

  try {
    const closed = await client.query(
      `UPDATE pmci.mm_market_config c
       SET enabled = false
       FROM pmci.provider_markets pm
       WHERE c.market_id = pm.id
         AND c.enabled = true
         AND pm.close_time IS NOT NULL
         AND pm.close_time < now()
       RETURNING c.market_id`,
    );
    summary.closed_disabled = closed.rowCount ?? 0;

    const rejectStorm = await client.query(
      `WITH t1 AS (
         SELECT pm.id,
                pm.provider_market_ref AS ticker,
                count(*)::int AS orders_1h,
                count(*) FILTER (WHERE mo.status = 'rejected')::int AS rejects_1h
         FROM pmci.mm_orders mo
         JOIN pmci.provider_markets pm ON pm.id = mo.market_id
         WHERE mo.placed_at > now() - interval '1 hour'
         GROUP BY pm.id, pm.provider_market_ref
       )
       UPDATE pmci.mm_market_config c
       SET enabled = false
       FROM t1
       WHERE c.market_id = t1.id
         AND c.enabled = true
         AND t1.orders_1h > 20
         AND t1.rejects_1h::float / NULLIF(t1.orders_1h, 0) > 0.5
       RETURNING t1.ticker, t1.orders_1h, t1.rejects_1h`,
    );
    summary.reject_storm_disabled = rejectStorm.rowCount ?? 0;

    for (const row of rejectStorm.rows) {
      const ticker = String(row.ticker);
      const orders1h = Number(row.orders_1h);
      const rejects1h = Number(row.rejects_1h);
      await client.query(
        `INSERT INTO pmci.mm_ticker_blocklist (ticker, reason, rejected_count, expires_at, notes)
         VALUES ($1, 'high_reject_rate', $2, now() + interval '24 hours', $3)
         ON CONFLICT (ticker) DO UPDATE SET
           reason = EXCLUDED.reason,
           rejected_count = EXCLUDED.rejected_count,
           expires_at = GREATEST(pmci.mm_ticker_blocklist.expires_at, EXCLUDED.expires_at),
           notes = COALESCE(EXCLUDED.notes, pmci.mm_ticker_blocklist.notes)`,
        [
          ticker,
          rejects1h,
          `auto: >50% rejects in 1h (${rejects1h}/${orders1h})`,
        ],
      );
      summary.blocklist_1h_rows += 1;
    }

    const bl24 = await client.query(
      `WITH t24 AS (
         SELECT pm.provider_market_ref AS ticker,
                count(*)::int AS orders_24h,
                count(*) FILTER (WHERE mo.status = 'rejected')::int AS rejects_24h
         FROM pmci.mm_orders mo
         JOIN pmci.provider_markets pm ON pm.id = mo.market_id
         WHERE mo.placed_at > now() - interval '24 hours'
         GROUP BY pm.provider_market_ref
         HAVING count(*) > 20
            AND count(*) FILTER (WHERE mo.status = 'rejected')::float / count(*)::float > 0.5
       )
       INSERT INTO pmci.mm_ticker_blocklist (ticker, reason, rejected_count, expires_at, notes)
       SELECT ticker,
              'high_reject_rate',
              rejects_24h,
              now() + interval '24 hours',
              'auto: >50% rejects in 24h (' || rejects_24h || '/' || orders_24h || ')'
       FROM t24
       ON CONFLICT (ticker) DO UPDATE SET
         reason = EXCLUDED.reason,
         rejected_count = EXCLUDED.rejected_count,
         expires_at = GREATEST(pmci.mm_ticker_blocklist.expires_at, EXCLUDED.expires_at),
         notes = COALESCE(EXCLUDED.notes, pmci.mm_ticker_blocklist.notes)
       RETURNING ticker`,
    );
    summary.blocklist_24h_rows = bl24.rowCount ?? 0;

    const ks = await client.query(
      `WITH ks AS (
         SELECT market_id
         FROM pmci.mm_kill_switch_events
         WHERE observed_at > now() - interval '1 hour'
           AND market_id IS NOT NULL
         GROUP BY market_id
         HAVING count(*) > 5
       )
       UPDATE pmci.mm_market_config c
       SET enabled = false
       FROM ks
       WHERE c.market_id = ks.market_id
         AND c.enabled = true
       RETURNING c.market_id`,
    );
    summary.kill_switch_disabled = ks.rowCount ?? 0;

    logger.info?.(
      `[rotator-disable-watcher] closed=${summary.closed_disabled} reject_storm=${summary.reject_storm_disabled} bl_1h=${summary.blocklist_1h_rows} bl_24h=${summary.blocklist_24h_rows} kill_sw=${summary.kill_switch_disabled}`,
    );
  } catch (e) {
    summary.ok = false;
    summary.error = e instanceof Error ? e.message : String(e);
    logger.warn?.(`[rotator-disable-watcher] fatal: ${summary.error}`);
  } finally {
    if (ownsClient) await client.end().catch(() => {});
  }

  summary.finished_at = new Date().toISOString();
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runRotatorDisableWatcher()
    .then((s) => {
      console.log(JSON.stringify(s));
      process.exit(s.ok ? 0 : 1);
    })
    .catch((err) => {
      console.error("[rotator-disable-watcher]", err);
      process.exit(1);
    });
}
