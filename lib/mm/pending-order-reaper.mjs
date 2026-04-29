/**
 * Reap orphaned mm_orders stuck in pending with NULL kalshi_order_id (place never ACK'd).
 * Scoped to enabled mm_market_config rows so stale pre-clock clusters stay untouched.
 */

const DEFAULT_INTERVAL_MS = 120_000;
const DEFAULT_STALE_AFTER_SEC = 60;

/**
 * Marks stale leaked pending rows as 'errored' and merges reap metadata into payload.
 * 'errored' aligns with placeLimitRow's terminal status on Kalshi place-throw, so all
 * place-failure rows route to a single status filter for ops dashboards.
 *
 * @param {import('pg').Client | import('pg').PoolClient} client
 * @returns {Promise<{ count: number }>}
 */
export async function reapStalePendingMmOrders(client) {
  const staleSec = Math.max(1, Number(process.env.MM_PENDING_STALE_SECONDS ?? DEFAULT_STALE_AFTER_SEC));

  const r = await client.query(
    `
    UPDATE pmci.mm_orders AS o
    SET status = 'errored',
        payload = COALESCE(o.payload, '{}'::jsonb)
          || jsonb_build_object(
            'pending_reaped_at',
            to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'pending_reap_reason',
            'stale_pending_no_kalshi_order_id',
            'pending_reap_stale_after_seconds',
            $1::int
          )
    FROM pmci.mm_market_config mc
    WHERE mc.market_id = o.market_id
      AND mc.enabled = true
      AND o.status = 'pending'
      AND o.placed_at < NOW() - ($1::bigint * INTERVAL '1 second')
      AND o.kalshi_order_id IS NULL
    RETURNING o.id
    `,
    [staleSec],
  );
  const count = r.rowCount ?? (r.rows?.length ?? 0);
  return { count };
}

/**
 * Runs {@link reapStalePendingMmOrders} at most once per interval (wall clock).
 * Mutates `state.pendingReaperLastMs` when a run executes.
 *
 * @param {import('pg').Client | import('pg').PoolClient} client
 * @param {{ pendingReaperLastMs?: number }} [state]
 */
export async function maybeReapStalePendingOrders(client, state) {
  const intervalMs = Math.max(5000, Number(process.env.MM_PENDING_REAPER_INTERVAL_MS ?? DEFAULT_INTERVAL_MS));
  const now = Date.now();
  const last = state?.pendingReaperLastMs;
  if (last != null && now - last < intervalMs) {
    return { ran: false, count: 0 };
  }

  const { count } = await reapStalePendingMmOrders(client);
  if (state) state.pendingReaperLastMs = now;
  return { ran: true, count };
}
