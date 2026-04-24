# Execution cost model (A2)

Single-leg helper for the pivot backtest: **fees** (published schedules), **v1 slippage** (flat one-way dollars), and **capital lockup** (financing on premium until resolution).

## API

Import from `lib/execution/costs.mjs`:

```js
import { estimateCost } from "./lib/execution/costs.mjs";

const r = estimateCost({
  venue: "kalshi", // or "polymarket"
  side: "yes", // or "no"
  price: 0.52, // YES probability in (0, 1)
  size: 100, // USD premium spent on this leg at entry
  hold_days: 14,
  liquidity_role: "taker", // optional; "maker" only changes Kalshi; Polymarket makers pay 0
  polymarket_category: "sports", // optional; see `fees.polymarket.mjs`
});
// r.total_cost_dollars — sum of fees + slippage + lockup
// r.breakdown — per-component numbers + fee_detail for debugging
```

There are no hidden globals; overrides are passed as options.

### Semantics

- **`price`**: Always the **YES** implied probability in \((0, 1)\). For a NO leg, the model uses contract price \(1 - \texttt{price}\) inside the venue fee formulas.
- **`size`**: **Premium USD** for this leg (cash you pay to acquire contracts/shares at entry), not notional payout at resolution.
- **`hold_days`**: Calendar days capital is tied up; used only for the financing term on **`size`** (opportunity cost), not for fee math.

## Where the numbers come from

| Input | Value / rule | Source & confidence |
|--------|----------------|---------------------|
| Kalshi taker coeff | `0.07` in \( \lceil 100 \cdot \text{coeff} \cdot C \cdot P(1-P) \rceil / 100 \) | [Kalshi fee schedule PDF](https://kalshi.com/docs/kalshi-fee-schedule.pdf); [fee rounding](https://docs.kalshi.com/getting_started/fee_rounding) — **published_by_venue** (PDF was HTTP 429 once; re-verify if fees change) |
| Kalshi maker coeff | `0.0175` | Same as above |
| Polymarket `feeRate` | By category (default **sports** `0.03`) | [Polymarket Fees](https://docs.polymarket.com/trading/fees) — **published_by_protocol_docs** |
| v1 slippage | `$0.02` one-way per leg | **conservative_working_guess** — not from an exchange |
| Annual financing | `4.5%` | **illustrative_proxy** — replace with your hurdle rate or spot T-bill from [Treasury yield curve](https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve) |

Every hardcoded fee coefficient lives in `fees.kalshi.mjs` and `fees.polymarket.mjs` with dated comments.

## When this model will lie to you

- **Simultaneous fills**: v1 assumes you pay the modeled fee and slippage on each leg independently; it does not model stale quotes, latency, or leg risk between venues.
- **No partial fills**: The model assumes each leg **fully fills at once** at the quoted cost basis (`size` as total premium for that leg). Real IOC/limit ladders can leave you **partially filled** or **one leg only**; residual inventory and unwind costs are not represented here.
- **Flat slippage**: Real slippage scales with size vs. book depth and volatility; v1 uses a constant dollar one-way guess, so thin books and large `size` will usually cost more than modeled.
- **Category defaults on Polymarket**: Fees are **per market** in production (`feesEnabled`, `getClobMarketInfo`). Using `"sports"` for every Polymarket leg can mis-state fees on miscategorized or fee-free markets (e.g. geopolitics per docs).
- **Kalshi rounding**: Live fills can include sub-cent **rounding fees** and accumulator rebates ([fee rounding](https://docs.kalshi.com/getting_started/fee_rounding)); v1 uses the main quadratic fee with **ceil to whole cents**, which may be slightly off vs. multi-fill sequences.
- **Maker vs taker**: Default is **taker** on both legs (conservative for arb). If you model resting liquidity, Kalshi maker fees apply; Polymarket makers still pay **zero** per docs — but you may not get filled when the spread appears.
- **Financing rate**: Lockup cost is linear and uses a single annual rate; it ignores margin, credit spreads, or the fact that resolution timing is uncertain.

## Version scope

v1 is intentionally minimal: one function, honest labels on guesses, no order-book ingestion, no per-family overrides. Refine after the first backtest or pilot fills if the rubric points at cost-model bias.
