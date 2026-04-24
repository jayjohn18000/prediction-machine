import { kalshiFeeUsdCeilCents } from "./fees.kalshi.mjs";
import { polymarketTakerFeeUsd } from "./fees.polymarket.mjs";

/**
 * v1 slippage: flat one-way dollar amount per leg (not order-book aware).
 *
 * Value: USD paid on entry to model adverse selection / half-spread — not from venue docs.
 * Confidence: conservative_working_guess for backtest v1.
 * What would change it: empirical slippage from pilot fills; depth-aware v2 model.
 */
export const V1_DEFAULT_SLIPPAGE_ONE_WAY_USD = 0.02;

/**
 * Annual opportunity cost of capital locked until resolution (financing rate).
 *
 * Value: 4.5% nominal annual (working pivot assumption).
 * Confidence: illustrative_proxy — replace with spot short-term risk-free rate when tightening.
 * What would change it: owner-chosen hurdle rate; observed margin / funding costs.
 *
 * For a spot cite at build time, see U.S. Treasury daily yield curve (e.g. 13-week bill):
 * https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve
 */
export const V1_DEFAULT_ANNUAL_FINANCING_RATE = 0.045;

const VENUES = new Set(["kalshi", "polymarket"]);
const SIDES = new Set(["yes", "no"]);
const ROLES = new Set(["taker", "maker"]);

function clamp01(priceYes, label) {
  const p = Number(priceYes);
  if (!Number.isFinite(p)) throw new TypeError(`${label} must be a finite number`);
  if (p <= 0 || p >= 1) {
    throw new RangeError(`${label} must be strictly between 0 and 1 (got ${priceYes})`);
  }
  return p;
}

function clampSize(size) {
  const s = Number(size);
  if (!Number.isFinite(s) || s < 0) throw new RangeError("size must be a non-negative finite number");
  return s;
}

function clampHoldDays(holdDays) {
  const h = holdDays == null ? 0 : Number(holdDays);
  if (!Number.isFinite(h) || h < 0) throw new RangeError("hold_days must be a non-negative finite number");
  return h;
}

/** Price of the traded contract in 0–1 dollars (Kalshi/Poly fee formulas use outcome price). */
export function contractPriceForSide(priceYes, side) {
  const p = clamp01(priceYes, "price");
  return side === "yes" ? p : 1 - p;
}

/** Contracts (Kalshi) / shares (Polymarket) bought when spending `premiumUsd` at entry. */
export function contractsFromPremiumUsd({ premiumUsd, priceYes, side }) {
  const pYes = clamp01(priceYes, "price");
  const px = contractPriceForSide(pYes, side);
  if (premiumUsd <= 0) return 0;
  return premiumUsd / px;
}

function financingCostUsd({ notionalUsd, holdDays, annualRate }) {
  if (notionalUsd <= 0 || holdDays <= 0) return 0;
  return notionalUsd * annualRate * (holdDays / 365);
}

/**
 * Estimated execution costs for a single leg (one venue, one fill).
 *
 * @param {object} params
 * @param {'kalshi'|'polymarket'} params.venue
 * @param {'yes'|'no'} params.side
 * @param {number} params.price - YES probability in (0,1); NO fees use 1−price as contract price.
 * @param {number} params.size - Premium USD deployed on this leg at entry (cash spent for contracts).
 * @param {number} [params.hold_days=0] - Calendar days until resolution (capital lockup).
 * @param {'taker'|'maker'} [params.liquidity_role='taker'] - Maker only affects Kalshi; Polymarket makers pay 0.
 * @param {string} [params.polymarket_category='sports'] - Polymarket feeRate bucket (see fees.polymarket.mjs).
 * @param {number} [params.slippage_one_way_usd] - Override v1 flat one-way slippage in USD.
 * @param {number} [params.annual_financing_rate] - Override annual opportunity rate.
 * @param {boolean} [params.include_capital_lockup=true]
 */
export function estimateCost(params) {
  const venue = params?.venue;
  const side = params?.side;
  if (!VENUES.has(venue)) throw new Error('estimateCost: venue must be "kalshi" or "polymarket"');
  if (!SIDES.has(side)) throw new Error('estimateCost: side must be "yes" or "no"');

  const liquidityRole = params.liquidity_role ?? "taker";
  if (!ROLES.has(liquidityRole)) throw new Error('estimateCost: liquidity_role must be "taker" or "maker"');

  const priceYes = clamp01(params.price, "price");
  const size = clampSize(params.size);
  const holdDays = clampHoldDays(params.hold_days);
  const includeLockup = params.include_capital_lockup !== false;

  const annualRate = params.annual_financing_rate ?? V1_DEFAULT_ANNUAL_FINANCING_RATE;
  const slipOneWay = params.slippage_one_way_usd ?? V1_DEFAULT_SLIPPAGE_ONE_WAY_USD;

  const contractPx = contractPriceForSide(priceYes, side);
  const contracts = contractsFromPremiumUsd({ premiumUsd: size, priceYes, side });

  let feesDollars = 0;
  let feeDetail = { venue, side, liquidity_role: liquidityRole, contracts, contract_price: contractPx };

  if (venue === "kalshi") {
    const tradeFee = kalshiFeeUsdCeilCents({
      contracts,
      contractPrice: contractPx,
      liquidityRole,
    });
    feesDollars = tradeFee;
    feeDetail = {
      ...feeDetail,
      fee_usd: tradeFee,
      schedule: "ceil_usd_to_cents( coeff × C × P × (1−P) )",
      coeff:
        liquidityRole === "maker"
          ? "0.0175 maker (see fees.kalshi.mjs)"
          : "0.07 taker (see fees.kalshi.mjs)",
    };
  } else {
    const category = params.polymarket_category ?? "sports";
    if (liquidityRole === "maker") {
      feesDollars = 0;
      feeDetail = {
        ...feeDetail,
        fee_usd: 0,
        schedule: "makers pay 0 per Polymarket docs",
        polymarket_category: category,
      };
    } else {
      const tradeFee = polymarketTakerFeeUsd({
        contracts,
        contractPrice: contractPx,
        category,
      });
      feesDollars = tradeFee;
      feeDetail = {
        ...feeDetail,
        fee_usd: tradeFee,
        schedule: "round_5dp( feeRate × C × p × (1−p) )",
        polymarket_category: category,
      };
    }
  }

  const slippageDollars = size > 0 ? Math.max(0, slipOneWay) : 0;
  const capitalLockupDollars = includeLockup
    ? financingCostUsd({ notionalUsd: size, holdDays, annualRate })
    : 0;

  const totalCostDollars = feesDollars + slippageDollars + capitalLockupDollars;

  return {
    total_cost_dollars: totalCostDollars,
    breakdown: {
      fees_dollars: feesDollars,
      slippage_dollars: slippageDollars,
      capital_lockup_dollars: capitalLockupDollars,
      fee_detail: feeDetail,
      slippage_detail: {
        model: "flat_one_way_usd",
        one_way_usd: slipOneWay,
        confidence: "conservative_working_guess",
      },
      capital_lockup_detail: includeLockup
        ? {
            model: "notional × annual_rate × (hold_days / 365)",
            notional_usd: size,
            hold_days: holdDays,
            annual_rate: annualRate,
          }
        : { model: "excluded", notional_usd: size, hold_days: holdDays },
    },
  };
}
