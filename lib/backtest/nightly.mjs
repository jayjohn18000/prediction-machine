import { createPgClient } from "../mm/order-store.mjs";
import { runBacktest } from "./engine.mjs";

export async function resolveNightlyMarketTicker(client) {
  const env = process.env.BACKTEST_NIGHTLY_MARKET?.trim();
  if (env) return env;
  const r = await client.query(
    `
    SELECT pm.provider_market_ref AS t
    FROM pmci.mm_market_config c
    JOIN pmci.provider_markets pm ON pm.id = c.market_id
    WHERE c.enabled = true
    LIMIT 1
    `,
  );
  return r.rows[0]?.t ?? null;
}

export async function runBacktestNightly() {
  const hypothesisId = process.env.BACKTEST_NIGHTLY_HYPOTHESIS?.trim() ?? "H-2026-001";
  const days = Math.max(1, Math.min(30, Number(process.env.BACKTEST_NIGHTLY_DAYS ?? 7)));
  const client = createPgClient();
  await client.connect();
  let ticker;
  try {
    ticker = await resolveNightlyMarketTicker(client);
  } finally {
    await client.end().catch(() => {});
  }
  if (!ticker) throw new Error("no market ticker (set BACKTEST_NIGHTLY_MARKET or enable mm_market_config)");
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400_000);
  return runBacktest({
    hypothesisId,
    marketTicker: ticker,
    startAt: start.toISOString(),
    endAt: end.toISOString(),
  });
}
