/**
 * Roll up MM fills into pmci.mm_positions (signed YES-contract net inventory).
 *
 * Concurrency model: every write goes through `recomputeMmPositionForMarket`,
 * which takes a per-market `pg_advisory_xact_lock(market_id)` and rebuilds the
 * full position from `pmci.mm_fills`. This makes the function idempotent — it
 * is safe to invoke from the live orchestrator on every new fill AND from the
 * one-shot backfill script in parallel without double-counting.
 */

/**
 * Increment to net YES-contract position (same semantics as spreadCapture side).
 *
 * @param {string} side
 * @param {number} sizeContracts strictly positive contract count
 * @returns {number} signed delta toward YES-equivalent contracts
 */
export function yesNetDeltaContracts(side, sizeContracts) {
  const sz = Math.max(0, Number(sizeContracts));
  if (!Number.isFinite(sz) || sz <= 0) return 0;
  const s = String(side ?? "");
  if (s === "yes_buy" || s === "no_sell") return sz;
  if (s === "yes_sell" || s === "no_buy") return -sz;
  return 0;
}

/**
 * @param {{ net_contracts: unknown, avg_cost_cents?: unknown|null, realized_pnl_cents?: unknown|null }} prev
 * @param {number} Δ signed YES net change
 * @param {number} P fill YES-equivalent cents
 */
export function rollupPositionAccounting(prev, Δ, P) {
  let N =
    prev.net_contracts != null && prev.net_contracts !== ""
      ? Number(prev.net_contracts)
      : 0;
  const A =
    prev.avg_cost_cents != null && prev.avg_cost_cents !== "" ? Number(prev.avg_cost_cents) : null;
  let R = prev.realized_pnl_cents != null ? Number(prev.realized_pnl_cents) : 0;

  if (!Number.isFinite(Δ)) throw new Error("rollupPositionAccounting: invalid delta");
  if (!Number.isFinite(P)) throw new Error("rollupPositionAccounting: invalid price");
  if (Δ === 0) return { net_contracts: N, avg_cost_cents: A, realized_pnl_cents: R };

  if (!Number.isFinite(N)) N = 0;

  if (N === 0) {
    const newN = Δ;
    if (newN === 0) return { net_contracts: 0, avg_cost_cents: null, realized_pnl_cents: R };
    return { net_contracts: newN, avg_cost_cents: P, realized_pnl_cents: R };
  }

  // Add to same-direction exposure.
  if ((N > 0 && Δ > 0) || (N < 0 && Δ < 0)) {
    const newN = N + Δ;
    if (!Number.isFinite(newN) || newN === 0) {
      return { net_contracts: 0, avg_cost_cents: null, realized_pnl_cents: R };
    }
    const newA = (Math.abs(N) * /** @type {number} */ (A) + Math.abs(Δ) * P) / Math.abs(newN);
    return { net_contracts: newN, avg_cost_cents: newA, realized_pnl_cents: R };
  }

  // Opposing: close partially, fully, or flip.
  const newN = N + Δ;

  // Partial close — still same sign as original N (did not flip or flat).
  if ((N > 0 && newN > 0) || (N < 0 && newN < 0)) {
    const closedQty = Math.abs(Δ);
    const contrib = N > 0 ? (P - /** @type {number} */ (A)) * closedQty : (/** @type {number} */ (A) - P) * closedQty;
    R += contrib;
    return { net_contracts: newN, avg_cost_cents: A, realized_pnl_cents: R };
  }

  // Flat.
  if (newN === 0) {
    const closedQty = Math.min(Math.abs(N), Math.abs(Δ));
    const contrib = N > 0 ? (P - /** @type {number} */ (A)) * closedQty : (/** @type {number} */ (A) - P) * closedQty;
    R += contrib;
    return { net_contracts: 0, avg_cost_cents: null, realized_pnl_cents: R };
  }

  // Flip: close entire old book in one fill; remainder opens at P.
  const closedFromOld = Math.abs(N);
  const contrib = N > 0 ? (P - /** @type {number} */ (A)) * closedFromOld : (/** @type {number} */ (A) - P) * closedFromOld;
  R += contrib;
  return { net_contracts: newN, avg_cost_cents: P, realized_pnl_cents: R };
}

/**
 * Pure: replay an ordered fill list (oldest → newest) through the rollup.
 * Exported for unit tests and for the backfill script's progress reporting.
 *
 * @param {Array<{ side: string, size_contracts: number|string, price_cents: number|string }>} fills
 */
export function replayFillsToPosition(fills) {
  let state = { net_contracts: 0, avg_cost_cents: null, realized_pnl_cents: 0 };
  for (const f of fills) {
    const Δ = yesNetDeltaContracts(f.side, Number(f.size_contracts));
    state = rollupPositionAccounting(state, Δ, Number(f.price_cents));
  }
  return state;
}

/**
 * @param {import('pg').Client | import('pg').PoolClient} client
 * @param {number|string} marketId
 * @returns {Promise<number|null>}
 */
export async function fetchLatestDepthMidCents(client, marketId) {
  const r = await client.query(
    `
    SELECT mid_cents
    FROM pmci.provider_market_depth
    WHERE provider_market_id = $1::bigint
      AND mid_cents IS NOT NULL
    ORDER BY observed_at DESC
    LIMIT 1
    `,
    [marketId],
  );
  const m = r.rows[0]?.mid_cents;
  return m != null && Number.isFinite(Number(m)) ? Number(m) : null;
}

export function unrealizedMtmFromMid(netContracts, avgCostCents, midCents) {
  const N = Number(netContracts);
  const avg = avgCostCents != null ? Number(avgCostCents) : null;
  const mid = midCents != null ? Number(midCents) : null;
  if (!Number.isFinite(N) || N === 0 || avg == null || !Number.isFinite(avg) || mid == null || !Number.isFinite(mid))
    return null;
  return (mid - avg) * N;
}

/**
 * Atomically rebuild pmci.mm_positions for one market from the full pmci.mm_fills history.
 *
 * Idempotent: calling N times in any order yields the same final row. Concurrency-safe:
 * acquires a per-market `pg_advisory_xact_lock` so a live ingest call and a backfill call
 * cannot interleave. Last fill wins on `last_updated`.
 *
 * @param {import('pg').Client | import('pg').PoolClient} client
 * @param {number|string} marketId
 * @returns {Promise<{ market_id: number, fills_seen: number, net_contracts: number, avg_cost_cents: number|null, realized_pnl_cents: number, unrealized_pnl_cents: number|null, last_updated: string|null }>}
 */
export async function recomputeMmPositionForMarket(client, marketId) {
  const mid = Number(marketId);
  if (!Number.isFinite(mid)) throw new Error("recomputeMmPositionForMarket: invalid marketId");

  await client.query(`BEGIN`);
  try {
    // Per-market advisory lock — held until COMMIT/ROLLBACK. Concurrent callers serialize.
    await client.query(`SELECT pg_advisory_xact_lock($1::bigint)`, [mid]);

    const fillsRes = await client.query(
      `
      SELECT side, size_contracts, price_cents, observed_at, id
      FROM pmci.mm_fills
      WHERE market_id = $1::bigint
      ORDER BY observed_at ASC, id ASC
      `,
      [mid],
    );
    const fills = fillsRes.rows ?? [];
    const rolled = replayFillsToPosition(fills);

    const midCents = await fetchLatestDepthMidCents(client, mid);
    const unr = unrealizedMtmFromMid(rolled.net_contracts, rolled.avg_cost_cents, midCents);

    const lastObservedAt = fills.length > 0 ? fills[fills.length - 1].observed_at : null;

    await client.query(
      `
      INSERT INTO pmci.mm_positions (
        market_id,
        net_contracts,
        avg_cost_cents,
        realized_pnl_cents,
        unrealized_pnl_cents,
        last_updated
      ) VALUES ($1::bigint, $2::int, $3::numeric, $4::numeric, $5::numeric, COALESCE($6::timestamptz, now()))
      ON CONFLICT (market_id) DO UPDATE SET
        net_contracts = EXCLUDED.net_contracts,
        avg_cost_cents = EXCLUDED.avg_cost_cents,
        realized_pnl_cents = EXCLUDED.realized_pnl_cents,
        unrealized_pnl_cents = EXCLUDED.unrealized_pnl_cents,
        last_updated = EXCLUDED.last_updated
      `,
      [
        mid,
        rolled.net_contracts,
        rolled.avg_cost_cents ?? null,
        rolled.realized_pnl_cents,
        unr,
        lastObservedAt != null ? new Date(lastObservedAt).toISOString() : null,
      ],
    );

    await client.query(`COMMIT`);

    return {
      market_id: mid,
      fills_seen: fills.length,
      net_contracts: rolled.net_contracts,
      avg_cost_cents: rolled.avg_cost_cents,
      realized_pnl_cents: rolled.realized_pnl_cents,
      unrealized_pnl_cents: unr,
      last_updated: lastObservedAt != null ? new Date(lastObservedAt).toISOString() : null,
    };
  } catch (err) {
    await client.query(`ROLLBACK`).catch(() => {});
    throw err;
  }
}

/**
 * Back-compat shim used by the orchestrator's fill-ingest hook. The new fill is
 * already in `pmci.mm_fills` (insertFill committed before this is called), so we
 * recompute from full history instead of applying an incremental delta — that's
 * what makes the function idempotent. Fill arg is unused but kept for call-site stability.
 *
 * @param {import('pg').Client | import('pg').PoolClient} client
 * @param {number|string} marketId
 * @param {object} [_fill] ignored — preserved for ABI compatibility
 */
export async function upsertPositionFromMmFill(client, marketId, _fill) {
  await recomputeMmPositionForMarket(client, marketId);
}
