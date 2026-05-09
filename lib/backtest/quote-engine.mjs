import { computeQuoteFromState } from "../mm/compute-quote.mjs";

export function buildSyntheticMmConfig(hypothesis) {
  const sr = hypothesis.sizing_rules ?? {};
  const perTrade = Number(sr.per_trade_size_c ?? 500);
  const maxNotional = Math.max(100, Math.min(50_000, perTrade));
  const baseSize = Math.max(1, Math.min(30, Math.floor(maxNotional / 50)));
  return {
    kill_switch_active: false,
    soft_position_limit: 5,
    hard_position_limit: 12,
    min_half_spread_cents: 2,
    base_size_contracts: baseSize,
    k_vol: 1,
    inventory_skew_cents: 15,
    max_order_notional_cents: maxNotional,
  };
}

function inWhelanBand(midCents) {
  return midCents >= 50 && midCents <= 80;
}

export function deriveQuotesForSnapshot(ctx) {
  const h = ctx.hypothesis;
  const book = ctx.book;
  const mid = book.midCents;
  if (mid == null || !Number.isFinite(mid)) return { mode: "none", resting: [], takers: [] };

  const type = String(h.inefficiency_type ?? "");
  if (type === "informational_lag") return informationalLagTakerQuotes(ctx);

  let mmConfig = buildSyntheticMmConfig(h);
  if (type === "structural") {
    if (inWhelanBand(mid)) mmConfig = { ...mmConfig, k_vol: 1.1 };
    else
      return { mode: "microstructure_skew", resting: [], takers: [], meta: { skip: "outside_whelan_band" } };

    const st = {
      fvCarry: ctx.fvByMarket[ctx.ticker] ?? {},
      netContractsYes: ctx.backtestState.netContractsFor(ctx.ticker),
      prevObservedMs: ctx.prevObservedMs,
    };
    const snap = {
      midCents: mid,
      bestBidCents: book.bestBidCents,
      bestAskCents: book.bestAskCents,
      spreadCents: book.spreadCents,
      observedAtMs: book.observedMs,
      nowMs: book.observedMs,
      weightKalshiLiquidity: book.weightKalshiLiquidity,
    };
    const bundle = computeQuoteFromState(st, snap, { mmConfig });
    ctx.fvByMarket[ctx.ticker] = bundle.fvCarryNext;
    const q = bundle.quote;
    if (q.halted) return { mode: "halt", resting: [], takers: [] };
    const resting = [];
    if (q.bidPx != null && q.bidSize > 0)
      resting.push({
        kind: "maker",
        mmSide: "yes_buy",
        priceCents: q.bidPx,
        size: q.bidSize,
        fairAtPlace: bundle.fairValue.fair_value_cents,
      });
    if (q.askPx != null && q.askSize > 0)
      resting.push({
        kind: "maker",
        mmSide: "yes_sell",
        priceCents: q.askPx,
        size: q.askSize,
        fairAtPlace: bundle.fairValue.fair_value_cents,
      });
    return { mode: "maker_mm", resting, takers: [], fair: bundle.fairValue };
  }

  const sign2 = Number(h.confidence ?? 0.5) - 0.5 >= 0 ? 1 : -1;
  const st2 = {
    fvCarry: ctx.fvByMarket[ctx.ticker] ?? {},
    netContractsYes: ctx.backtestState.netContractsFor(ctx.ticker),
    prevObservedMs: ctx.prevObservedMs,
  };
  const snap2 = {
    midCents: mid + sign2 * 0.25,
    bestBidCents: book.bestBidCents,
    bestAskCents: book.bestAskCents,
    spreadCents: book.spreadCents,
    observedAtMs: book.observedMs,
    nowMs: book.observedMs,
    weightKalshiLiquidity: book.weightKalshiLiquidity,
  };
  const bundle2 = computeQuoteFromState(st2, snap2, { mmConfig: buildSyntheticMmConfig(h) });
  ctx.fvByMarket[ctx.ticker] = bundle2.fvCarryNext;
  const q2 = bundle2.quote;
  if (q2.halted) return { mode: "halt", resting: [], takers: [] };
  const resting2 = [];
  if (q2.bidPx != null && q2.bidSize > 0)
    resting2.push({
      kind: "maker",
      mmSide: "yes_buy",
      priceCents: q2.bidPx,
      size: q2.bidSize,
      fairAtPlace: bundle2.fairValue.fair_value_cents,
    });
  if (q2.askPx != null && q2.askSize > 0)
    resting2.push({
      kind: "maker",
      mmSide: "yes_sell",
      priceCents: q2.askPx,
      size: q2.askSize,
      fairAtPlace: bundle2.fairValue.fair_value_cents,
    });
  return { mode: "maker_mm", resting: resting2, takers: [], fair: bundle2.fairValue };
}

const LAG_MS = 30_000;
const LAG_DIV_C = 3;

function informationalLagTakerQuotes(ctx) {
  const book = ctx.book;
  const mid = /** @type {number} */ (book.midCents);
  const deque = ctx.midDeque;
  const now = book.observedMs;
  deque.push({ t: now, m: mid });
  while (deque.length > 0 && deque[0].t < now - LAG_MS * 2) deque.shift();
  const old = deque.find((x) => x.t <= now - LAG_MS) ?? deque[0] ?? null;
  if (!old || Math.abs(mid - old.m) < LAG_DIV_C) return { mode: "lag_wait", resting: [], takers: [] };
  const sr = ctx.hypothesis.sizing_rules ?? {};
  const perTrade = Math.max(1, Math.floor(Number(sr.per_trade_size_c ?? 500) / 100));
  if (mid > old.m)
    return {
      mode: "taker",
      resting: [],
      takers: [
        {
          kind: "taker",
          mmSide: "yes_buy",
          size: perTrade,
          fairAtPlace: old.m,
          bestBidCents: book.bestBidCents,
          bestAskCents: book.bestAskCents,
        },
      ],
    };
  return {
    mode: "taker",
    resting: [],
    takers: [
      {
        kind: "taker",
        mmSide: "yes_sell",
        size: perTrade,
        fairAtPlace: old.m,
        bestBidCents: book.bestBidCents,
        bestAskCents: book.bestAskCents,
      },
    ],
  };
}
