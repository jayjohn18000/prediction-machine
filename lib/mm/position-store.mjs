/**
 * Roll up MM fills into pmci.mm_positions (signed YES-contract net inventory).
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
 * After a NEW mm_fills row — UPSERT pmci.mm_positions.
 *
 * @param {import('pg').Client | import('pg').PoolClient} client
 * @param {number|string} marketId
 * @param {{ side: string, size_contracts: number, price_cents: number, observed_at?: string|Date }} fill
 */
export async function upsertPositionFromMmFill(client, marketId, fill) {
  const mid = await fetchLatestDepthMidCents(client, marketId);
  const res = await client.query(
    `
    SELECT net_contracts, avg_cost_cents, realized_pnl_cents
    FROM pmci.mm_positions
    WHERE market_id = $1::bigint
    `,
    [marketId],
  );
  const prev = res.rows[0] ?? {};

  const Δ = yesNetDeltaContracts(fill.side, fill.size_contracts);
  const rolled = rollupPositionAccounting(prev, Δ, Number(fill.price_cents));
  const unr = unrealizedMtmFromMid(rolled.net_contracts, rolled.avg_cost_cents, mid);

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
      marketId,
      rolled.net_contracts,
      rolled.avg_cost_cents ?? null,
      rolled.realized_pnl_cents,
      unr,
      fill.observed_at != null ? new Date(fill.observed_at).toISOString() : null,
    ],
  );
}
