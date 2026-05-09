export async function resolveKalshiProviderMarketId(client, marketTicker) {
  const pidR = await client.query(
    `
    SELECT pm.id AS id
    FROM pmci.provider_markets pm
    JOIN pmci.providers pr ON pr.id = pm.provider_id AND pr.code = 'kalshi'
    WHERE pm.provider_market_ref = $1
    LIMIT 1
    `,
    [marketTicker],
  );
  const id = pidR.rows[0]?.id;
  if (id == null) throw new Error(`unknown Kalshi market ticker: ${marketTicker}`);
  return Number(id);
}

export async function openSnapshotCursor(client, p) {
  const k = { lastObservedAt: null, lastId: null };
  return {
    async next(batch = 250) {
      const lim = Math.max(1, Math.min(2000, Math.floor(batch)));
      const r =
        k.lastObservedAt == null
          ? await client.query(
              `
              SELECT s.id, s.observed_at, s.price_yes, s.best_bid_yes, s.best_ask_yes,
                     s.liquidity, s.volume_24h, s.raw
              FROM pmci.provider_market_snapshots s
              WHERE s.provider_market_id = $1::bigint
                AND s.observed_at >= $2::timestamptz
                AND s.observed_at < $3::timestamptz
              ORDER BY s.observed_at ASC, s.id ASC
              LIMIT $4::int
              `,
              [p.providerMarketId, p.startAt, p.endAt, lim],
            )
          : await client.query(
              `
              SELECT s.id, s.observed_at, s.price_yes, s.best_bid_yes, s.best_ask_yes,
                     s.liquidity, s.volume_24h, s.raw
              FROM pmci.provider_market_snapshots s
              WHERE s.provider_market_id = $1::bigint
                AND s.observed_at >= $2::timestamptz
                AND s.observed_at < $3::timestamptz
                AND (s.observed_at, s.id) > ($4::timestamptz, $5::bigint)
              ORDER BY s.observed_at ASC, s.id ASC
              LIMIT $6::int
              `,
              [p.providerMarketId, p.startAt, p.endAt, k.lastObservedAt, k.lastId, lim],
            );
      const rows = r.rows ?? [];
      if (rows.length > 0) {
        const last = rows[rows.length - 1];
        k.lastObservedAt = last.observed_at;
        k.lastId = Number(last.id);
      }
      return rows;
    },
    async close() {},
  };
}

export function normalizeProviderSnapshotRow(row, observedMsOverride) {
  const py = row.price_yes != null ? Number(row.price_yes) : null;
  const bb = row.best_bid_yes != null ? Number(row.best_bid_yes) : null;
  const ba = row.best_ask_yes != null ? Number(row.best_ask_yes) : null;
  const midCents = py != null && Number.isFinite(py) ? Math.round(py * 10_000) / 100 : null;
  const bestBidCents = bb != null && Number.isFinite(bb) ? Math.round(bb * 10_000) / 100 : null;
  const bestAskCents = ba != null && Number.isFinite(ba) ? Math.round(ba * 10_000) / 100 : null;
  let spreadCents = null;
  if (bestBidCents != null && bestAskCents != null && bestAskCents > bestBidCents) {
    spreadCents = Math.round(bestAskCents - bestBidCents);
  }
  const observedAt = row.observed_at;
  const observedMs =
    observedMsOverride ??
    (observedAt instanceof Date ? observedAt.getTime() : new Date(observedAt).getTime());
  const LkRaw = row.liquidity ?? row.volume_24h ?? 1;
  const Lk = Math.max(1, Number(LkRaw) || 1);
  return {
    id: row.id,
    observedAt,
    observedMs,
    midCents,
    bestBidCents,
    bestAskCents,
    spreadCents,
    weightKalshiLiquidity: Lk,
    raw: row.raw,
  };
}
