/**
 * MM quoting-decision helpers (plan §quoting-engine).
 */

/**
 * Clamp integer to inclusive range.
 *
 * @param {number} n
 */
function clampInt(n, lo, hi) {
  return Math.max(lo, Math.min(hi, Math.round(Number(n))));
}

/**
 * Clamp fraction.
 *
 * @param {number} x
 */
function clampUnit(x, lo = -1, hi = 1) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(lo, Math.min(hi, x));
}

/**
 * @param {number} net YES-equivalent contracts
 * @param {number} soft
 * @param {number} hard
 */
export function contractsSizeStep(netContracts, soft, hard, baseSize) {
  const a = Math.abs(netContracts);
  if (a >= hard) return 0;
  if (a >= soft) return Math.max(0, Math.floor(baseSize / 2));
  return Math.max(1, Math.floor(baseSize));
}

/** Buy YES size — zero when long at hard cap. */
export function sizeForBidSide(netContracts, soft, hard, baseSize) {
  if (netContracts >= hard) return 0;
  const a = Math.abs(netContracts);
  const b = Math.max(1, Math.floor(baseSize));
  if (a >= soft && a < hard) return Math.max(1, Math.floor(b / 2));
  return b;
}

/** Sell YES size — zero when short at hard cap. */
export function sizeForAskSide(netContracts, soft, hard, baseSize) {
  if (netContracts <= -hard) return 0;
  const a = Math.abs(netContracts);
  const b = Math.max(1, Math.floor(baseSize));
  if (a >= soft && a < hard) return Math.max(1, Math.floor(b / 2));
  return b;
}

/** Notional invariant: shrink size to fit ceiling. */
export function capSizeForNotional(priceCents, size, maxNotionalCents) {
  if (size <= 0) return 0;
  const p = Number(priceCents);
  const cap = Number(maxNotionalCents);
  if (!Number.isFinite(p) || p <= 0 || !Number.isFinite(cap) || cap <= 0) return 0;
  const maxSz = Math.floor(cap / p);
  return Math.max(0, Math.min(size, maxSz));
}

/**
 * Decide resting bid/ask in YES-price cents — **bid** buys YES (**yes_buy** wire), **ask** sells YES (**yes_sell**).
 *
 * Inventory skew pulls both sides in the unwind direction toward flat (same shift on bid and ask — plan §skew).
 *
 * @param {object} p
 * @param {number} p.fairCents fair value 1–99
 * @param {number} [p.netContractsYes] Kalshi-ish inventory (+ long YES exposure)
 * @param {number} [p.volEstimateCents] positive scale for vol widening
 * @param {{
 *   soft_position_limit:number,
 *   hard_position_limit:number,
 *   min_half_spread_cents:number,
 *   base_size_contracts:number,
 *   k_vol: number|string|null,
 *   kill_switch_active:boolean,
 *   max_order_notional_cents: number|string,
 * }} p.config `mm_market_config` subset
 */
export function decideQuote(p) {
  const cfg = p.config ?? {};
  if (cfg.kill_switch_active === true) {
    return {
      bidPx: null,
      bidSize: 0,
      askPx: null,
      askSize: 0,
      halted: true,
      halfSpreadCents: 0,
      skewAppliedCents: 0,
      reason: "kill_switch",
    };
  }

  const fairRaw = Number(p.fairCents ?? 50);
  const fair = Number.isFinite(fairRaw) ? clampInt(fairRaw, 1, 99) : 50;
  const inv = Number(p.netContractsYes ?? 0);
  const soft = Math.max(0, Number(cfg.soft_position_limit ?? 0));
  const hardRaw = Number(cfg.hard_position_limit ?? 1);
  const hard = hardRaw <= 0 ? 1 : hardRaw;

  const kVol = cfg.k_vol != null ? Number(cfg.k_vol) : 1;
  const volEs = Math.max(0.5, Number(p.volEstimateCents ?? 1));
  const minHalf = Math.max(1, Number(cfg.min_half_spread_cents ?? 1));
  const half = Math.ceil(Math.max(minHalf, kVol * volEs));

  const skewFullCent = Number(
    typeof globalThis.process !== "undefined" && globalThis.process?.env?.MM_SKEW_CENTS_AT_HARD
      ? globalThis.process.env.MM_SKEW_CENTS_AT_HARD
      : 15,
  );
  /** Long YES ⇒ shift book down toward selling YES. */
  let shift = skewFullCent !== 0 ? -Math.round(skewFullCent * clampUnit(inv / hard)) : 0;

  let bidPx = clampInt(fair - half + shift, 1, 98);
  let askPx = clampInt(fair + half + shift, 3, 99);
  if (askPx <= bidPx) {
    shift = 0;
    bidPx = clampInt(fair - half, 1, 98);
    askPx = clampInt(fair + half, Math.min(99, bidPx + 2), 99);
  }

  const base = Number(cfg.base_size_contracts ?? 1);
  let bidSize = sizeForBidSide(inv, soft, hard, base);
  let askSize = sizeForAskSide(inv, soft, hard, base);

  const maxNom = Number(cfg.max_order_notional_cents ?? 999_999_999);
  bidSize = capSizeForNotional(bidPx, bidSize, maxNom);
  askSize = capSizeForNotional(askPx, askSize, maxNom);

  return {
    bidPx: bidPx,
    bidSize,
    askPx,
    askSize,
    halted: false,
    halfSpreadCents: half,
    skewAppliedCents: shift,
  };
}

/**
 * Throttle versus last worked prices (within min_requote_cents).
 *
 * @param {object} opts
 */
export function applyMinRequoteGuard(opts) {
  const band = Number(opts.minRequoteCents ?? 1);
  const lb = opts.lastBidCents ?? null;
  const la = opts.lastAskCents ?? null;
  const bidPx = opts.newBidPx;
  const askPx = opts.newAskPx;
  const out = { rebidBid: true, reboundAsk: true };
  if (lb != null && bidPx != null && Math.abs(bidPx - lb) < band) {
    out.rebidBid = false;
  }
  if (la != null && askPx != null && Math.abs(askPx - la) < band) {
    out.reboundAsk = false;
  }
  return out;
}
