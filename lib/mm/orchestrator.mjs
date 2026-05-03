/**
 * MM orchestrator — `mm_market_config.enabled` → fair-value → quoting → kalshi-trader (W3).
 * KalshiTrader is constructed only here (CLAUDE invariant).
 */

import { updateFairValue } from "./fair-value.mjs";
import { decideQuote, applyMinRequoteGuard } from "./quoting-engine.mjs";
import {
  checkPreTrade,
  fetchPortfolioDailyNetPnLCentsUtc,
  triggerKillSwitch,
  tryAutoReset,
  shouldTripKillSwitchOnFailure,
} from "./risk.mjs";
import { KalshiTrader, loadPrivateKey } from "../providers/kalshi-trader.mjs";
import {
  createPgClient,
  insertMmOrderPending,
  updateMmOrderFromKalshiResponse,
  updateMmOrderStatus,
  markMmOrderRejectedKalshi,
} from "./order-store.mjs";
import { nextClientOrderId } from "./client-order-id.mjs";
import { reconcileOnRestart } from "./restart-reconciliation.mjs";
import { refreshLastToxicityScore, evaluateKillSwitchCondition } from "./toxicity.mjs";
import { maybeReapStalePendingOrders } from "./pending-order-reaper.mjs";
import { mapKalshiOrderStatus } from "./kalshi-order-status.mjs";
import { ingestFillsForTicker } from "./ingest-fills.mjs";
import { kalshiEnvFromMode, guardKalshiTradingBase } from "./kalshi-env.mjs";

export { mapKalshiOrderStatus } from "./kalshi-order-status.mjs";
export { mapKalshiFillToMmSide, fillYesPriceCents } from "./kalshi-fill-normalize.mjs";
export { ingestFillsForTicker };

/** @param {string} tradeBase */
export async function fetchKalshiMarketSnapshot(tradeBase, ticker) {
  const base = tradeBase.replace(/\/$/, "");
  const res = await fetch(`${base}/markets/${encodeURIComponent(ticker)}`);
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Kalshi public market ${ticker}: HTTP ${res.status}`);
  const m = j.market ?? j;
  const yb =
    m.yes_bid_dollars != null
      ? Number(m.yes_bid_dollars) * 100
      : m.yes_bid != null
        ? Number(m.yes_bid)
        : null;
  const ya =
    m.yes_ask_dollars != null
      ? Number(m.yes_ask_dollars) * 100
      : m.yes_ask != null
        ? Number(m.yes_ask)
        : null;
  let mid = null;
  if (yb != null && ya != null && ya > yb) mid = (yb + ya) / 2;
  else if (m.last_price_dollars != null) mid = Number(m.last_price_dollars) * 100;
  const spreadCents =
    yb != null && ya != null && ya > yb ? Math.round(ya - yb) : Math.min(99, Number(process.env.MM_DEFAULT_VOL_CE ?? 12));
  const LkRaw = m.volume_24h ?? m.volume_24h_fp ?? m.open_interest ?? m.open_interest_fp ?? 1;
  const Lk = Math.max(1, Number(LkRaw) || 1);
  return {
    midCents: mid,
    spreadCents,
    weightKalshiLiquidity: Lk,
    observedAtMs: Date.now(),
    bestBidCents: yb,
    bestAskCents: ya,
    fractionalTradingEnabled: m.fractional_trading_enabled === true,
    priceLevelStructure: m.price_level_structure != null ? String(m.price_level_structure) : null,
  };
}

/**
 * One-shot startup reconcile stamp for HTTP /health/mm.
 * @param {Record<string, unknown>} health
 * @param {{ phase: string, skipped: boolean, timedOut?: boolean }} reconciliation
 */
export function stampStartupReconcileHealth(health, reconciliation) {
  if (!health) return;
  const iso = new Date().toISOString();
  /** @type {any} */
  (health).lastStartupReconcileAt = iso;
  /** deprecated: prefer lastStartupReconcileAt; remove after 2026-06-01 */
  /** @type {any} */
  (health).lastReconcileAt = iso;
  /** @type {any} */
  (health).reconcilePhase = reconciliation.phase;
  /** @type {any} */
  (health).reconcileSkipped = reconciliation.skipped;
  /** @type {any} */
  (health).lastReconcileTimedOut = reconciliation.timedOut === true;
}

/** @param {import('pg').Client | import('pg').PoolClient} client */
export async function fetchEnabledMarketConfigs(client) {
  const r = await client.query(
    `
    SELECT c.*,
           pm.provider_market_ref AS kalshi_ticker
    FROM pmci.mm_market_config c
    JOIN pmci.provider_markets pm ON pm.id = c.market_id
    JOIN pmci.providers pr ON pr.id = pm.provider_id AND pr.code = 'kalshi'
    WHERE c.enabled = true
    `,
  );
  return r.rows ?? [];
}

async function readInventoryYes(client, marketPk) {
  const r = await client.query(`SELECT net_contracts FROM pmci.mm_positions WHERE market_id = $1 LIMIT 1`, [
    marketPk,
  ]);
  return r.rows[0]?.net_contracts != null ? Number(r.rows[0].net_contracts) : 0;
}

/**
 * @param {unknown} err
 * @param {string} clientOrderId
 */
export function buildKalshiPlacementErrorBlock(err, clientOrderId) {
  const e = /** @type {any} */ (err);
  const statusNum = e?.status != null && Number.isFinite(Number(e.status)) ? Number(e.status) : null;
  const body = e?.body !== undefined ? e.body : null;
  let requestId = null;
  if (body && typeof body === "object" && body !== null) {
    const rid = /** @type {Record<string, unknown>} */ (body).request_id ?? /** @type {Record<string, unknown>} */ (body).requestId;
    if (rid != null) requestId = String(rid);
  }
  return {
    status: statusNum,
    body,
    request_id: requestId,
    client_order_id: clientOrderId,
    captured_at: new Date().toISOString(),
  };
}

async function placeLimitRow(p) {
  const { client, trader, marketPk, kalshiTicker, mmSide, priceCents, size, fairValuePlace, bookAtPlace } = p;
  if (!size || size <= 0 || !priceCents) return null;
  const coid = nextClientOrderId({ ticker: kalshiTicker, side: mmSide, reuseRetry: false });
  const row = await insertMmOrderPending(client, {
    market_id: marketPk,
    client_order_id: coid,
    side: mmSide,
    price_cents: Math.round(priceCents),
    size_contracts: Math.round(size),
    fair_value_at_place: fairValuePlace,
    payload: { w3_mm: true },
    best_bid_cents_at_place: bookAtPlace?.bestBidCents ?? null,
    best_ask_cents_at_place: bookAtPlace?.bestAskCents ?? null,
    book_depth_at_place_jsonb: {
      best_bid_cents: bookAtPlace.bestBidCents ?? null,
      best_ask_cents: bookAtPlace.bestAskCents ?? null,
      price_level_structure: bookAtPlace.priceLevelStructure ?? null,
      fractional_trading_enabled: bookAtPlace.fractionalTradingEnabled ?? null,
    },
  });
  let res;
  try {
    res = await trader.createOrderFromMM({
      ticker: kalshiTicker,
      mmSide,
      priceCents: Math.round(priceCents),
      sizeContracts: Math.round(size),
      clientOrderId: coid,
      postOnly: true,
    });
  } catch (e) {
    const block = buildKalshiPlacementErrorBlock(e, coid);
    try {
      console.error("mm.placement.kalshi_error", JSON.stringify(block));
    } catch {
      console.error("mm.placement.kalshi_error", block);
    }
    await markMmOrderRejectedKalshi(client, row.id, block);
    throw e;
  }
  const ord = res?.order ?? res;
  const oid = ord?.order_id;
  await updateMmOrderFromKalshiResponse(client, {
    internalOrderPk: row.id,
    kalshi_order_id: oid,
    status: mapKalshiOrderStatus(ord?.status ?? "resting"),
  });
  return oid ?? null;
}

async function replaceRow(p) {
  const { trader, prevKalshiOrderId, ...rest } = p;
  if (prevKalshiOrderId) void trader.cancelOrder(prevKalshiOrderId).catch(() => {});
  return placeLimitRow({ trader, ...rest });
}

/** Best-effort cancel both working legs and clear wm entry */
async function cancelBothLegs(trader, w) {
  if (w?.bidOrd) await trader.cancelOrder(String(w.bidOrd)).catch(() => {});
  if (w?.askOrd) await trader.cancelOrder(String(w.askOrd)).catch(() => {});
  w.bidOrd = null;
  w.askOrd = null;
  w.bidPx = null;
  w.askPx = null;
}

/**
 * Returns the active Kalshi REST base URL — DEMO or PROD per `MM_RUN_MODE`.
 * Delegates to lib/mm/kalshi-env.mjs which is the single source of truth for
 * the env switch (ADR-011 / ADR-012). Kept exported under the historical name
 * for backward compatibility.
 */
export function kalshiTradeBaseUrlFromEnv() {
  return kalshiEnvFromMode().restBase;
}

/**
 * Soft-warn when the resolved REST base doesn't match the active run mode.
 * Re-exported under the historical name; new code should call
 * `guardKalshiTradingBase` from `lib/mm/kalshi-env.mjs` directly.
 *
 * @param {string} baseUrl
 */
export function guardDemoTradingBase(baseUrl) {
  guardKalshiTradingBase(baseUrl, kalshiEnvFromMode().runMode);
}

async function processMarketRow(params) {
  const {
    client,
    trader,
    tradeBase,
    row,
    wm,
    fvCarry,
    prevTick,
    ls,
    portfolioDailyPnLCents,
  } = params;
  const ticker = String(row.kalshi_ticker);
  const pk = Number(row.market_id);
  /** @type {string[]} */
  const logs = [];

  // ADR-011 cutover gate / lane-11 finding: close intra-tick race where one
  // market trips kill_switch but sibling markets still see the cached
  // `row.kill_switch_active=false` for the rest of the tick. Re-read per-market
  // on every tick. PK lookup; cheap.
  try {
    const ks = await client.query(
      `SELECT kill_switch_active FROM pmci.mm_market_config WHERE market_id = $1::bigint LIMIT 1`,
      [pk],
    );
    if (ks.rows[0]?.kill_switch_active === true) {
      row.kill_switch_active = true;
    }
  } catch (e) {
    // Don't fail the tick on a transient DB error here; the cached row covers
    // us. Log so operator can see if reads are persistently failing.
    logs.push(`${ticker} kill_switch_recheck_err ${/** @type {Error} */ (e).message}`);
  }

  if (row.kill_switch_active === true) {
    logs.push(`${ticker} kill_switch_active=1 — skipping quote/risk path`);
    return logs;
  }

  const toxFresh = await refreshLastToxicityScore({ client, marketId: pk });
  row.last_toxicity_score = toxFresh.score;

  const snap = await fetchKalshiMarketSnapshot(tradeBase, ticker).catch((e) => {
    logs.push(`${ticker} snapshot_fail ${/** @type {Error} */ (e).message}`);
    return null;
  });
  if (!snap || snap.midCents == null || !Number.isFinite(Number(snap.midCents))) return logs;

  const nowMs = Date.now();
  ls[ticker] = nowMs;
  const dtMs = prevTick[ticker] != null ? nowMs - prevTick[ticker] : undefined;
  prevTick[ticker] = nowMs;

  const fv = updateFairValue({
    state: fvCarry[ticker] ?? {},
    midKalshiCents: snap.midCents,
    midPolyCents: null,
    weightKalshiLiquidity: snap.weightKalshiLiquidity,
    weightPolyLiquidity: null,
    nowMs,
    dtMs,
    midObservedMs: snap.observedAtMs,
  });
  fvCarry[ticker] = {
    emaCents: fv.carry.emaCents,
    lastEmitMs: fv.carry.lastEmitMs,
    updates: fv.carry.updates,
    confidence: fv.carry.confidence,
  };

  const inv = await readInventoryYes(client, pk);
  const q = decideQuote({
    fairCents: fv.fair_value_cents,
    netContractsYes: inv,
    volEstimateCents: snap.spreadCents,
    config: row,
    topOfBook: { bestBidCents: snap.bestBidCents, bestAskCents: snap.bestAskCents },
  });

  if (q.halted) return logs.concat([`${ticker} halted kill_switch=${row.kill_switch_active}`]);

  if (q.bidSkippedReason) {
    logs.push(`${ticker} quote_skip side=bid reason=${q.bidSkippedReason}`);
  }
  if (q.askSkippedReason) {
    logs.push(`${ticker} quote_skip side=ask reason=${q.askSkippedReason}`);
  }

  wm[ticker] = wm[ticker] ?? { bidPx: null, askPx: null, bidOrd: null, askOrd: null };

  /** @type {any} */
  const w = wm[ticker];

  const risk = await checkPreTrade({
    client,
    config: row,
    ticker,
    fairCents: fv.fair_value_cents,
    netContractsYes: inv,
    snapshotObservedAtMs: ls[ticker],
    nowMs,
    quoteSnapshot: {
      bidPx: q.bidPx,
      bidSize: q.bidSize,
      askPx: q.askPx,
      askSize: q.askSize,
    },
    portfolioDailyPnLCents,
  });

  if (!risk.ok) {
    if (risk.failedGate === "stale_snapshot") {
      await cancelBothLegs(trader, w);
      logs.push(`${ticker} risk_stale_cancelled`);
      return logs;
    }
    if (shouldTripKillSwitchOnFailure(risk.failedGate)) {
      await triggerKillSwitch({
        client,
        trader,
        marketId: pk,
        ticker,
        reason: String(risk.failedGate),
        details: { gates: risk.gates, details: risk.details },
      });
      await cancelBothLegs(trader, w);
      logs.push(`${ticker} kill_switch_triggered reason=${risk.failedGate}`);
      return logs;
    }
    logs.push(`${ticker} risk_block gate=${risk.failedGate}`);
    return logs;
  }

  const guard = applyMinRequoteGuard({
    minRequoteCents: Number(row.min_requote_cents ?? 1),
    lastBidCents: w.bidPx,
    lastAskCents: w.askPx,
    newBidPx: q.bidPx,
    newAskPx: q.askPx,
  });

  if (snap.observedAtMs != null && nowMs - snap.observedAtMs > Number(row.stale_quote_timeout_seconds ?? 600) * 1000) {
    logs.push(`${ticker} stale_quote_warn`);
  }

  if (guard.rebidBid && q.bidPx != null && q.bidSize > 0) {
    try {
      const bookAtPlace = {
        bestBidCents: snap.bestBidCents,
        bestAskCents: snap.bestAskCents,
        priceLevelStructure: snap.priceLevelStructure,
        fractionalTradingEnabled: snap.fractionalTradingEnabled,
      };
      const oid = await replaceRow({
        client,
        trader,
        marketPk: pk,
        kalshiTicker: ticker,
        mmSide: "yes_buy",
        priceCents: q.bidPx,
        size: q.bidSize,
        fairValuePlace: fv.fair_value_cents,
        bookAtPlace,
        prevKalshiOrderId: w.bidOrd,
      });
      w.bidOrd = oid;
      w.bidPx = q.bidPx;
      logs.push(`${ticker} bid ${q.bidPx}c x${q.bidSize} fv=${Number(fv.fair_value_cents).toFixed(3)} oid=${oid}`);
    } catch (e) {
      logs.push(`${ticker} bid_err ${/** @type {Error} */ (e).message}`);
    }
  }

  if (guard.reboundAsk && q.askPx != null && q.askSize > 0) {
    try {
      const bookAtPlace = {
        bestBidCents: snap.bestBidCents,
        bestAskCents: snap.bestAskCents,
        priceLevelStructure: snap.priceLevelStructure,
        fractionalTradingEnabled: snap.fractionalTradingEnabled,
      };
      const oid = await replaceRow({
        client,
        trader,
        marketPk: pk,
        kalshiTicker: ticker,
        mmSide: "yes_sell",
        priceCents: q.askPx,
        size: q.askSize,
        fairValuePlace: fv.fair_value_cents,
        bookAtPlace,
        prevKalshiOrderId: w.askOrd,
      });
      w.askOrd = oid;
      w.askPx = q.askPx;
      logs.push(`${ticker} ask ${q.askPx}c x${q.askSize} oid=${oid}`);
    } catch (e) {
      logs.push(`${ticker} ask_err ${/** @type {Error} */ (e).message}`);
    }
  }

  const fillRun = await ingestFillsForTicker(client, trader, ticker, pk);
  logs.push(...fillRun.logs);

  if (fillRun.newFills > 0) {
    const ks = await evaluateKillSwitchCondition({
      client,
      trader,
      marketId: pk,
      ticker,
      marketConfig: row,
      currentDailyPnl: portfolioDailyPnLCents,
    });
    if (ks.triggered) {
      await cancelBothLegs(trader, w);
      logs.push(`${ticker} kill_switch_triggered reason=${ks.reason}`);
      return logs;
    }
  }

  return logs;
}

/**
 * Single pass across enabled configs.
 *
 * @param {object} [opts]
 */
export async function runMmOrchestratorSession(opts = {}) {
  const kalshiEnv = kalshiEnvFromMode();
  const tradeBase = opts.tradeBaseUrl ?? kalshiEnv.restBase;
  guardKalshiTradingBase(tradeBase, kalshiEnv.runMode);

  const keyId = opts.keyId ?? kalshiEnv.apiKeyId;
  if (!keyId?.trim()) {
    throw new Error(
      kalshiEnv.runMode === "prod"
        ? "KALSHI_PROD_API_KEY_ID required for orchestrator trading (MM_RUN_MODE=prod)"
        : "KALSHI_DEMO_API_KEY_ID required for orchestrator trading",
    );
  }

  const pemPath = kalshiEnv.privateKeyPath;
  const pemInline = kalshiEnv.privateKeyInline;
  const pk = opts.privateKey ?? loadPrivateKey({ path: pemPath, inline: pemInline });

  /** @type {import('pg').Client | import('pg').PoolClient} */
  const client = opts.pgClient ?? createPgClient(opts.connectionString ?? process.env.DATABASE_URL?.trim());
  const ownsClient = opts.pgClient == null;
  if (ownsClient) await /** @type {any} */ (/** @type {unknown} */ (client)).connect();

  const st = opts.state ?? { wm: {}, fv: {}, pt: {}, ls: {} };

  const trader = new KalshiTrader({ baseTradeUrl: tradeBase, keyId: String(keyId), privateKey: pk });

  const portfolioDailyPnLCents =
    opts.portfolioDailyPnLCentsCached ??
    opts.portfolioDailyPnLCents ??
    (await fetchPortfolioDailyNetPnLCentsUtc(client));

  /** @type {string[]} */
  const out = [];
  try {
    const rows = opts.markets ?? (await fetchEnabledMarketConfigs(client));
    if (!rows.length) {
      out.push("no_enabled_mm_market_config_seed_first");
      return out;
    }
    for (const row of rows) {
      await tryAutoReset(client, row.market_id, { portfolioDailyPnLCents });
      /** @type {any} */
      const lines = await processMarketRow({
        client,
        trader,
        tradeBase,
        row,
        wm: /** @type {*} */ st.wm,
        fvCarry: /** @type {*} */ st.fv,
        prevTick: /** @type {*} */ st.pt,
        ls: /** @type {*} */ st.ls,
        portfolioDailyPnLCents,
      });
      for (const ln of lines) {
        console.log("[mm]", ln);
        out.push(ln);
      }
    }
  } finally {
    if (ownsClient) await /** @type {any} */ (/** @type {*} */ client).end().catch(() => {});
  }
  return out;
}

/** Loop — default MM_DURATION_MS unset = run until killed (production). */
export async function runMmOrchestratorLoop(opts = {}) {
  const tickMs = Math.max(2500, Number(opts.intervalMs ?? process.env.MM_TICK_MS ?? 5000));
  const rawDur = opts.durationMs ?? process.env.MM_DURATION_MS;
  const deadline =
    rawDur === undefined || rawDur === "" || String(rawDur).toLowerCase() === "infinity"
      ? Infinity
      : Date.now() + Math.max(5000, Number(rawDur));
  /** @type {string[]} */
  const agg = [];
  const state = opts.state ?? { wm: {}, fv: {}, pt: {}, ls: {} };
  /** @type {{ loopTick?: number }} */
  const health = opts.health ?? {};
  const reconcileOuterTimeoutMs = opts.reconcileOuterTimeoutMs ?? 30000;

  const client =
    opts.pgClient ?? createPgClient(opts.connectionString ?? process.env.DATABASE_URL?.trim());
  const ownClient = opts.pgClient == null;
  if (ownClient) await /** @type {any} */ (client).connect();

  try {
    const kalshiEnv = kalshiEnvFromMode();
    const tradeBase = opts.tradeBaseUrl ?? kalshiEnv.restBase;
    guardKalshiTradingBase(tradeBase, kalshiEnv.runMode);

    const keyId = opts.keyId ?? kalshiEnv.apiKeyId;
    if (!keyId?.trim()) {
      throw new Error(
        kalshiEnv.runMode === "prod"
          ? "KALSHI_PROD_API_KEY_ID required for orchestrator trading (MM_RUN_MODE=prod)"
          : "KALSHI_DEMO_API_KEY_ID required for orchestrator trading",
      );
    }
    const pemPath = kalshiEnv.privateKeyPath;
    const pemInline = kalshiEnv.privateKeyInline;
    const pk = opts.privateKey ?? loadPrivateKey({ path: pemPath, inline: pemInline });

    let rows = opts.markets;
    if (!rows) rows = await fetchEnabledMarketConfigs(client);

    let portfolioDailyPnLCentsCached = opts.portfolioDailyPnLCentsCached;
    if (portfolioDailyPnLCentsCached === undefined && client) {
      portfolioDailyPnLCentsCached = await fetchPortfolioDailyNetPnLCentsUtc(client);
    }

    if (!rows?.length) {
      agg.push("no_enabled_mm_market_config_seed_first");
    } else {
      const traderPre = new KalshiTrader({
        baseTradeUrl: tradeBase,
        keyId: String(keyId),
        privateKey: pk,
      });
      const reconcileImpl = opts.reconcileImpl ?? reconcileOnRestart;
      const reconciliation = await Promise.race([
        reconcileImpl({ client, trader: traderPre, markets: rows }),
        new Promise((resolve) => {
          setTimeout(() => {
            console.warn("mm.orchestrator.reconcile_outer_timeout", { ms: reconcileOuterTimeoutMs });
            resolve({
              phase: "W4",
              skipped: true,
              timedOut: true,
              logs: [],
              wmPatch: {},
            });
          }, reconcileOuterTimeoutMs);
        }),
      ]);
      for (const ln of reconciliation.logs) {
        console.log("[mm]", ln);
        agg.push(`reconcile: ${ln}`);
      }
      for (const [t, patch] of Object.entries(reconciliation.wmPatch ?? {})) {
        state.wm[t] = { ...(state.wm[t] ?? {}), ...patch };
      }
      const now = Date.now();
      for (const row of rows) {
        const t = String(row.kalshi_ticker);
        if (state.ls[t] == null) state.ls[t] = now;
      }
      if (opts.health) {
        stampStartupReconcileHealth(/** @type {any} */ (opts.health), reconciliation);
      }
    }

    let tick = 0;
    while (rows?.length && Date.now() < deadline) {
      tick += 1;
      health.loopTick = tick;
      if (opts.health) {
        /** @type {any} */ (opts.health).lastMainLoopTickAt = new Date().toISOString();
        /** @type {any} */ (opts.health).loopTick = tick;
      }

      const reap = await maybeReapStalePendingOrders(client, state);
      if (reap.ran && reap.count > 0) {
        agg.push(`reaped ${reap.count} stale pending`);
        if (opts.health) /** @type {any} */ (opts.health).lastReaperRunAt = new Date().toISOString();
      }

      const batch = await (opts.runSessionImpl ?? runMmOrchestratorSession)({
        markets: rows,
        tradeBaseUrl: opts.tradeBaseUrl,
        keyId: opts.keyId,
        privateKey: opts.privateKey,
        connectionString: opts.connectionString,
        pgClient: /** @type {*} */ (client),
        state,
        portfolioDailyPnLCentsCached,
      });
      agg.push(...batch);
      if (opts.health) {
        /** @type {any} */ (opts.health).lastSessionLineCount = batch.length;
      }
      await new Promise((r) => setTimeout(r, tickMs));
    }
  } finally {
    if (ownClient) await /** @type {any} */ (client).end().catch(() => {});
  }
  return agg;
}
