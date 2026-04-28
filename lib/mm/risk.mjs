/**
 * MM pre-trade gates + kill-switch helpers (W4).
 *
 * Gates (8): kill_switch, market_disabled, position_hard, daily_loss, stale_snapshot,
 *            notional_cap, fair_value_range, toxicity_score
 */

/**
 * @typedef {'kill_switch'|'market_disabled'|'position_hard'|'daily_loss'|'stale_snapshot'|'notional_cap'|'fair_value_range'|'toxicity_score'} RiskGate
 */

/** @param {import('pg').Client | import('pg').PoolClient} client */
export async function fetchPortfolioDailyNetPnLCentsUtc(client) {
  const r = await client.query(`
    SELECT COALESCE(SUM(net_pnl_cents), 0)::numeric AS n
    FROM pmci.mm_pnl_snapshots
    WHERE observed_at >= date_trunc('day', now())
  `);
  const v = r.rows[0]?.n;
  return v != null ? Number(v) : 0;
}

export function toxicityThresholdFromEnv() {
  const raw = process.env.MM_TOXICITY_KILL_SCORE?.trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {{
 *   client: import('pg').Client | import('pg').PoolClient,
 *   config: Record<string, unknown>,
 *   ticker: string,
 *   fairCents: number|null|undefined,
 *   netContractsYes: number,
 *   snapshotObservedAtMs: number|null|undefined,
 *   nowMs?: number,
 *   quoteSnapshot?: {
 *     bidPx: number|null,
 *     bidSize: number,
 *     askPx: number|null,
 *     askSize: number,
 *   },
 *   portfolioDailyPnLCents?: Promise<number> | number,
 * }} ctx
 * @returns {Promise<{ ok: boolean, failedGate: RiskGate|null, gates: Record<RiskGate, boolean>, details?: object }>}
 */
export async function checkPreTrade(ctx) {
  /** @type {Record<string, boolean>} */
  const gates = {};
  const cfg = ctx.config ?? {};
  const nowMs = ctx.nowMs ?? Date.now();

  const mark = (name, pass) => {
    gates[name] = pass;
    return pass;
  };

  if (!mark("kill_switch", cfg.kill_switch_active !== true)) {
    return { ok: false, failedGate: "kill_switch", gates };
  }
  if (!mark("market_disabled", cfg.enabled !== false)) {
    return { ok: false, failedGate: "market_disabled", gates };
  }

  const hardRaw = Number(cfg.hard_position_limit ?? 1);
  const hard = hardRaw <= 0 ? 1 : hardRaw;
  const inv = Number(ctx.netContractsYes ?? 0);
  /** Breach only if strictly past hard — at hard unwind-only sizing is quoting-engine territory */
  if (!mark("position_hard", Math.abs(inv) <= hard)) {
    return { ok: false, failedGate: "position_hard", gates, details: { inv, hard } };
  }

  let portPnl = ctx.portfolioDailyPnLCents;
  if (portPnl != null && typeof portPnl === "object" && "then" in /** @type {any} */ (portPnl)) {
    portPnl = await /** @type {Promise<number>} */ (portPnl);
  }
  const pnlNum = Number(portPnl ?? 0);
  const dailyLimit = Number(cfg.daily_loss_limit_cents ?? 0);
  if (dailyLimit > 0 && pnlNum <= -dailyLimit) {
    mark("daily_loss", false);
    return { ok: false, failedGate: "daily_loss", gates, details: { pnlCents: pnlNum, dailyLimit } };
  }
  mark("daily_loss", true);

  const staleSec = Number(cfg.stale_quote_timeout_seconds ?? 600);
  const obs = ctx.snapshotObservedAtMs;
  if (obs != null && Number.isFinite(obs)) {
    const ageSec = (nowMs - obs) / 1000;
    if (!mark("stale_snapshot", ageSec <= staleSec)) {
      return { ok: false, failedGate: "stale_snapshot", gates, details: { ageSec, staleSec } };
    }
  } else {
    mark("stale_snapshot", false);
    return { ok: false, failedGate: "stale_snapshot", gates, details: { reason: "no_snapshot_ts" } };
  }

  const maxNom = Number(cfg.max_order_notional_cents ?? 0);
  const q = ctx.quoteSnapshot;
  if (q && maxNom > 0) {
    const bidN = q.bidPx != null && q.bidSize > 0 ? q.bidPx * q.bidSize : 0;
    const askN = q.askPx != null && q.askSize > 0 ? q.askPx * q.askSize : 0;
    if (!mark("notional_cap", bidN <= maxNom && askN <= maxNom)) {
      return { ok: false, failedGate: "notional_cap", gates, details: { bidN, askN, maxNom } };
    }
  } else {
    mark("notional_cap", true);
  }

  const fv = Number(ctx.fairCents);
  if (!mark("fair_value_range", Number.isFinite(fv) && fv >= 1 && fv <= 99)) {
    return { ok: false, failedGate: "fair_value_range", gates, details: { fairCents: ctx.fairCents } };
  }

  const toxThresh = toxicityThresholdFromEnv();
  const tox = cfg.last_toxicity_score != null ? Number(cfg.last_toxicity_score) : null;
  if (toxThresh != null && tox != null && Number.isFinite(tox) && tox >= toxThresh) {
    gates["toxicity_score"] = false;
    return { ok: false, failedGate: "toxicity_score", gates, details: { tox, toxThresh } };
  }
  gates["toxicity_score"] = true;

  return { ok: true, failedGate: null, gates };
}

/**
 * DB kill flag + audit row + optional best-effort cancels.
 *
 * @param {object} p
 * @param {import('pg').Client | import('pg').PoolClient} p.client
 * @param {import('../providers/kalshi-trader.mjs').KalshiTrader} p.trader
 * @param {number|string} p.marketId
 * @param {string} p.reason
 * @param {string} p.ticker
 * @param {object} [p.details]
 */
export async function triggerKillSwitch(p) {
  const { client, trader, marketId, reason, ticker, details } = p;

  await client.query(
    `
    INSERT INTO pmci.mm_kill_switch_events (market_id, reason, details)
    VALUES ($1::bigint, $2::text, $3::jsonb)
    `,
    [marketId, reason, JSON.stringify(details ?? {})],
  );

  await client.query(
    `UPDATE pmci.mm_market_config SET kill_switch_active = true WHERE market_id = $1::bigint`,
    [marketId],
  );

  /** Best-effort: cancel resting orders for ticker */
  try {
    let j = await trader.getOrders({ ticker: String(ticker), status: "resting" }).catch(() => null);
    let orders = /** @type {any[]} */ (j?.orders ?? j?.order_updates ?? []);
    if (!orders.length) {
      j = await trader.getOrders({ ticker: String(ticker) }).catch(() => null);
      const raw = j?.orders ?? [];
      orders = Array.isArray(raw)
        ? raw.filter((o) => String(o?.status ?? "").toLowerCase() === "resting")
        : [];
    }
    for (const o of orders) {
      const oid = o?.order_id ?? o?.id;
      if (oid) await trader.cancelOrder(String(oid)).catch(() => {});
    }
  } catch {
    /* swallow — kill flag is authoritative */
  }

  return { ok: true };
}

/**
 * Optional auto-clear when env MM_AUTO_KILL_SWITCH_RESET=1 and limits no longer breached.
 *
 * @param {import('pg').Client | import('pg').PoolClient} client
 * @param {number|string} marketId
 * @param {{ portfolioDailyPnLCents?: number }} [ctx]
 */
export async function tryAutoReset(client, marketId, ctx = {}) {
  if (process.env.MM_AUTO_KILL_SWITCH_RESET !== "1") {
    return { reset: false, reason: "disabled" };
  }

  const r = await client.query(
    `SELECT kill_switch_active, daily_loss_limit_cents, hard_position_limit FROM pmci.mm_market_config WHERE market_id = $1`,
    [marketId],
  );
  const row = r.rows[0];
  if (!row?.kill_switch_active) return { reset: false, reason: "not_active" };

  const pnl = ctx.portfolioDailyPnLCents ?? (await fetchPortfolioDailyNetPnLCentsUtc(client));
  const dailyLimit = Number(row.daily_loss_limit_cents ?? 0);
  if (dailyLimit > 0 && pnl <= -dailyLimit) {
    return { reset: false, reason: "daily_loss_still_breached" };
  }

  const invRes = await client.query(`SELECT net_contracts FROM pmci.mm_positions WHERE market_id = $1`, [marketId]);
  const inv = invRes.rows[0]?.net_contracts != null ? Number(invRes.rows[0].net_contracts) : 0;
  const hard = Number(row.hard_position_limit ?? 1);
  if (Math.abs(inv) >= hard) {
    return { reset: false, reason: "position_hard_still_breached" };
  }

  await client.query(
    `UPDATE pmci.mm_market_config SET kill_switch_active = false WHERE market_id = $1`,
    [marketId],
  );
  await client.query(
    `INSERT INTO pmci.mm_kill_switch_events (market_id, reason, details)
     VALUES ($1::bigint, 'auto_reset', $2::jsonb)`,
    [marketId, JSON.stringify({ pnl_cents: pnl, net_contracts: inv })],
  );

  return { reset: true, reason: "cleared" };
}

export function shouldTripKillSwitchOnFailure(failedGate) {
  return failedGate === "daily_loss" || failedGate === "toxicity_score";
}
