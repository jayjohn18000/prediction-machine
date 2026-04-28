/**
 * Toxicity scoring + automated kill-switch evaluation (W5).
 */

import { triggerKillSwitch } from "./risk.mjs";

/** Default consecutive adverse fills gate (both legs against us). */
const DEFAULT_CONSECUTIVE_ADVERSE = 5;

/**
 * @param {{ client: import('pg').Client | import('pg').PoolClient, marketId: number|string, windowMinutes?: number }} p
 */
export async function computeToxicityScore(p) {
  const { client, marketId } = p;
  const windowMinutes = Math.max(1, Number(p.windowMinutes ?? 60));

  const r = await client.query(
    `
    SELECT adverse_cents_5m
    FROM pmci.mm_fills
    WHERE market_id = $1::bigint
      AND observed_at > now() - ($2::int * interval '1 minute')
      AND adverse_cents_5m IS NOT NULL
    `,
    [marketId, windowMinutes],
  );

  const rows = r.rows ?? [];
  let sum = 0;
  for (const row of rows) {
    const a = Number(row.adverse_cents_5m);
    if (!Number.isFinite(a)) continue;
    sum += a;
  }
  const count = rows.length;

  const meanAdverse = count > 0 ? sum / count : 0;
  const toxicityScore = count > 0 ? (meanAdverse * Math.sqrt(count)) / 10 : 0;

  return {
    score: toxicityScore,
    mean_adverse: meanAdverse,
    count,
    fills_examined: count,
  };
}

/**
 * Persist `last_toxicity_score` for `checkPreTrade` / dashboards.
 *
 * @param {{ client: import('pg').Client | import('pg').PoolClient, marketId: number|string, windowMinutes?: number }} p
 */
export async function refreshLastToxicityScore(p) {
  const { client, marketId } = p;
  const t = await computeToxicityScore(p);
  await client.query(`UPDATE pmci.mm_market_config SET last_toxicity_score = $2::numeric WHERE market_id = $1::bigint`, [
    marketId,
    t.score,
  ]);
  return t;
}

/**
 * Trip kill-switch on toxicity breach, portfolio daily loss vs per-market limit, or consecutive adverse fills.
 *
 * @param {{
 *   client: import('pg').Client | import('pg').PoolClient,
 *   trader: import('../providers/kalshi-trader.mjs').KalshiTrader,
 *   marketId: number|string,
 *   ticker: string,
 *   marketConfig: Record<string, unknown>,
 *   currentDailyPnl?: number,
 *   consecutiveAdverseN?: number,
 *   toxicitySnapshot?: Awaited<ReturnType<typeof computeToxicityScore>>,
 * }} p
 */
export async function evaluateKillSwitchCondition(p) {
  const {
    client,
    trader,
    marketId,
    ticker,
    marketConfig,
    currentDailyPnl = 0,
    consecutiveAdverseN = DEFAULT_CONSECUTIVE_ADVERSE,
    toxicitySnapshot,
  } = p;

  if (marketConfig.kill_switch_active === true) {
    return { triggered: false, reason: null, skipped: "already_active" };
  }

  const tox =
    toxicitySnapshot ??
    (await computeToxicityScore({ client, marketId, windowMinutes: 60 }));

  await client.query(`UPDATE pmci.mm_market_config SET last_toxicity_score = $2::numeric WHERE market_id = $1::bigint`, [
    marketId,
    tox.score,
  ]);

  const threshold = Number(marketConfig.toxicity_threshold ?? 500);
  if (Number.isFinite(threshold) && tox.score > threshold) {
    await triggerKillSwitch({
      client,
      trader,
      marketId,
      ticker,
      reason: "toxicity_threshold",
      details: { toxicity: tox, threshold },
    });
    return { triggered: true, reason: "toxicity_threshold", toxicity: tox };
  }

  const dailyLimit = Number(marketConfig.daily_loss_limit_cents ?? 0);
  const pnl = Number(currentDailyPnl);
  if (dailyLimit > 0 && Number.isFinite(pnl) && pnl <= -dailyLimit) {
    await triggerKillSwitch({
      client,
      trader,
      marketId,
      ticker,
      reason: "daily_loss",
      details: { pnl_cents: pnl, daily_limit_cents: dailyLimit },
    });
    return { triggered: true, reason: "daily_loss" };
  }

  const consec = await client.query(
    `
    SELECT adverse_cents_5m
    FROM pmci.mm_fills
    WHERE market_id = $1::bigint AND adverse_cents_5m IS NOT NULL
    ORDER BY observed_at DESC
    LIMIT $2::int
    `,
    [marketId, consecutiveAdverseN],
  );
  const advRows = consec.rows ?? [];
  if (
    advRows.length >= consecutiveAdverseN &&
    advRows.every((row) => Number(row.adverse_cents_5m) > 0)
  ) {
    await triggerKillSwitch({
      client,
      trader,
      marketId,
      ticker,
      reason: "consecutive_adverse_fills",
      details: { n: consecutiveAdverseN, sample: advRows.slice(0, consecutiveAdverseN) },
    });
    return { triggered: true, reason: "consecutive_adverse_fills" };
  }

  return { triggered: false, reason: null, toxicity: tox };
}
