---
title: PMCI Published-Edges Playbook (Path 2 + Bot Pre-Arm Checklist)
tags: [strategy, playbook, whelan, path-2, mm-bot, v1]
status: current
last-verified: 2026-05-08
sources:
  - "[[scanner-handoff-brief-2026-05-06]]"
  - "[[2026-05-06-mm-philosophy-pivot]]"
  - "[[scanner-plan-v1]]"
  - "https://www.karlwhelan.com/Papers/Kalshi.pdf"
---

# Published-Edges Playbook

**Created:** 2026-05-08
**Status:** ACTIVE for trading; runs in parallel with scanner planning
**Audience:** operator (manual trades) + `pmci-mm-runtime` operator (bot pre-arm checklist)

---

## §1 Purpose

This playbook documents the **academically validated structural edges** from the Whelan paper (Bartlett & O'Hara, *Adverse Selection in Prediction Markets: Evidence from Kalshi*, Apr 2026, 41.6M trades) and the operational checklist required before re-arming `pmci-mm-runtime` to trade them.

These edges do not require the scanner. They are documented in literature with empirical support behind them. They are the slow boring grind that runs while the scanner discovers richer opportunities.

The Whelan edges are categorical opportunities — predictable structural biases that exist because of who trades on Kalshi (retail-dominated audience) and how the contracts are priced. They will erode as institutional flow grows, but at v1 they remain net-positive.

---

## §2 The three Whelan rules

From the paper's empirical findings on 41.6M Kalshi trades:

### Rule 1 — Buy contracts in the 50–80¢ band

The favorite-longshot bias yields *small positive after-fee returns* in this band. Avoid the >$0.85 band (favorites overpriced) and avoid the <$0.20 band (longshots underpriced is a myth on retail Kalshi — that's where lottery-buyers cluster).

### Rule 2 — Never buy contracts <10¢

Lottery loss bias: contracts <$0.10 lose >60% of expected value on average. The retail tendency to buy "long-shot tickets" (treating contracts as $1 lottery picks) gets exploited by the makers on the other side.

### Rule 3 — Always be a maker, never a taker, on entry

22 percentage-point gap between maker outcomes and taker outcomes. Taking liquidity on entry pays the spread + fees + adverse-selection on every trade. Resting limit orders harvests the spread back.

---

## §3 Sizing rules (capital-scaled)

Sizing scales with total capital. Operator defines `total_capital` weekly.

| Capital | Per-position | Daily loss cap | Halt-for-week |
|---|---|---|---|
| $35 | $5 | $5 | -$10 |
| $100 | $10 | $10 | -$25 |
| $250 | $20 | $20 | -$50 |
| $500 | $35 | $35 | -$100 |
| $1000+ | up to 5% per position | up to 3% portfolio | -10% portfolio |

Maximum concurrent positions = `min(5, capital / per_position_size)`.

---

## §4 Markets to focus on

In rough priority order:

1. **Long-running political markets** (e.g., 2028 nominees, control of Congress) — slow drift, no in-play volatility, structural bias is stable, days-to-weeks holding period.
2. **Macro markets with known release schedule** (CPI, FOMC, jobs) — trade well *before* the release; close out before the release if winning. The structural bias is on the pre-release uncertainty band.
3. **Long-dated sports series** (NHL Stanley Cup winner, NBA Finals winner, MLB World Series winner) — less in-play noise than single games. Single in-play games are explicitly OUT (see §5).

Markets to AVOID for Path 2:

- In-play sports (the toxic flow that killed the symmetric MM strategy)
- Crypto micro-markets (latency arb territory, not structural)
- Anything <$0.10 (rule 2)
- Anything >$0.85 (favorites overpriced)
- Any market with <$50 daily volume (capacity-bound; slippage eats the edge)

---

## §5 Manual workflow (operator)

The default path. Three to five trades per week, manual via Kalshi UI.

**Daily ritual (10 minutes morning):**

1. Open Kalshi market list, filter to political + macro + long-dated sports
2. Sort by 24h volume (high to low) — you want liquid books
3. Skim for any market with current bid in 50–80¢ band where you have a directional view (or where the bid is in the band and you're agnostic — bias says buy is positive expected even without a view)
4. If a market clears the 3 rules + sizing fits, place a *resting* limit order at the inside bid or 1c better. Never market-buy on entry.
5. Log the trade in your spreadsheet: `date, market, side, size_c, entry_price, mechanism (rule), expected_close_date`

**Weekly ritual (15 minutes Sunday):**

1. Review the past week's trades — winners, losers, decay
2. Close any position that's hit your exit rule (3-month hold OR price moved to within 2c of $1.00 OR thesis broken)
3. Compute realized PnL for the week
4. Update the sizing column in the spreadsheet if capital changed

---

## §6 Bot-driven workflow (pmci-mm-runtime)

Once `pmci-mm-runtime` is re-armed (post pre-arm checklist, §7), it can trade Path 2 edges automatically alongside scanner-driven edges. The bot subscribes to the alert webhook from the scanner and, separately, runs a daily Whelan-band scan via the Track A SQL job in `scanner-plan-v1.md` §5.2.

The bot's Path 2 trade decision is simpler than the scanner-driven path:

```
nightly: scanner_structural_signals (detector_track='whelan_band') gives band-level statistics
         operator confirms the band-edge is still positive for the week
         pmci-mm-runtime places resting limit orders in markets where:
           - current_bid in 50–80c band
           - market_24h_volume > $50
           - market_close_date > 7 days out
           - sizing_rules.per_trade_size respected
           - daily_loss_cap not breached
```

No taker orders. Resting limit orders only. The bot's risk gates layer on top per Freqtrade's `IProtection` ABC pattern (drawdown ladder, cooldown, per-market loss cap).

---

## §7 Pre-arm checklist for `pmci-mm-runtime`

**MANDATORY** before re-enabling the bot. The bot last ran from 2026-05-02 to 2026-05-06 and lost 56% of capital running symmetric Avellaneda-Stoikov on MLB single-name markets — textbook adverse selection on trending sports books. The redesign requires verification of every parameter that contributed to the blowup.

Adapted from `rodlaf/KalshiMarketMaker`'s public post-mortem ("I Lost $150 in 20 Minutes Market-Making on Kalshi"), which documented six specific parameter mistakes on a strategy structurally similar to PMCI's.

### 7.1 Parameter audit (binary YES/NO each)

- [ ] **Inventory skew sign verified.** Long inventory must shift reservation price *down* (encourage selling). Property test: with `q=+10` (long), `reservation_price < mid`. With `q=-10` (short), `reservation_price > mid`. (rodlaf bug 1: sign inverted, bot trend-followed its own inventory)
- [ ] **Spread multiplication verified.** Whatever multiplier on `min_half_spread` exists in code must produce a spread > 0 for all valid inputs. Property test: `compute_half_spread(any_valid_state) > 0`. (rodlaf bug 2: multiplied by 0.01, spread collapsed to floor)
- [ ] **Sigma scaled for [0,1] price space.** Avellaneda-Stoikov sigma should be 0.05–0.15 for binary contracts (NOT 0.001 which is calibrated for crypto). Property test: `sigma_estimator(historical_kalshi_prices)` returns value in [0.05, 0.15]. (rodlaf bug 3: sigma off by 100x for binary)
- [ ] **Market-selection scoring direction verified.** Wider spread should score *lower* (it's worse — more execution friction), not higher. Property test: `score(narrow_spread_market) > score(wide_spread_market)` holding all else equal. (rodlaf bug 4: scored wider higher)
- [ ] **MVE / scalar-strike markets blocklisted.** Hard ticker-prefix block (defense in depth — API params alone miss combos). The PMCI prefix block already exists in `mm-rotator-disable-watcher`; verify it's active and includes all known problem prefixes (`KXMVE`, `KXLCPIMAXYOY`, etc.). (rodlaf bug 5: MVE markets bought-and-stuck)
- [ ] **Position sizing × concurrent cap is consistent.** `per_trade_size × max_concurrent_positions ≤ total_capital × 0.5`. (rodlaf bug 6: top_n=50 with 20-contract cap = sub-position dust)

### 7.2 Strategy redesign (must be present before live)

- [ ] **VPIN toxicity gate.** Port `jheusser/vpin` core (~30 LOC). Compute VPIN per ticker from `mm_orders` + Kalshi trade prints. Gate quote placement when `VPIN > 0.7` for 60s. *This is the v1 patch; do not arm without it.*
- [ ] **Game-state pull gate (in-play sports only — opt-in per market).** When `|dWP/dt|` from hoopR spikes during scoring plays / timeouts / late-game high-leverage spots, pull quotes for 60s. *Path 2 markets are not in-play; this is a guardrail in case the bot is allowed to trade scanner-driven NBA edges in v1.5.*
- [ ] **Drawdown ladder operational.** -1% portfolio → halve size; -2% → quote one-sided to flatten; -3% → full halt. Schema-enforced via `pmci.kill_switch_events`.
- [ ] **One-sided fill cap.** 3 consecutive same-side fills → flatten + 10-min cooldown. Per-market.
- [ ] **Pre-trade adjust gate.** Hummingbot-style `BudgetChecker.adjust_candidate()` pattern: every order is *adjusted before submission* against current budget, not blocked after. Reduces order size if needed; blocks only if size would fall below `min_position_size_c`.

### 7.3 Operational gates (before live capital flows)

- [ ] **Schema migration applied** (scanner schema from `scanner-plan-v1.md` §8). Adds `mode` and `hypothesis_id` columns to `mm_orders` and `mm_pnl_snapshots`.
- [ ] **`MM_RUN_MODE=paper` smoke test passed for ≥48 hours.** Bot runs end-to-end in paper mode against live market data; all writes go to `mm_orders.mode='paper'`. Daily PnL snapshot tracks. No exception in the orchestrator log.
- [ ] **Property tests run on parameter audit.** Section 7.1 list above must pass automated tests, not just manual review.
- [ ] **Operator sign-off in `decision-log.md`.** ADR entry documenting the re-arm decision, the parameters, and the kill criteria.

### 7.4 Re-arm procedure (Day 0)

1. Apply schema migration
2. Deploy bot in `MM_RUN_MODE=paper` for 48h smoke test
3. Run Section 7.1 + 7.2 + 7.3 checklist; all checkboxes green
4. Operator writes ADR entry
5. Set `MM_RUN_MODE=prod`
6. Initial capital allocation: 25% of total. Hold for 7 days. Scale to 50% if criteria met. Scale to 100% only after another 7 days.

---

## §8 Explicit non-goals

The published-edges playbook does NOT:
- Try to MM in-play sports (the toxic flow that killed the previous attempt)
- Trade contracts <10¢ (lottery zone — Whelan rule 2)
- Take liquidity on entry (Whelan rule 3)
- Use scanner-driven hypotheses (those are gated by the hypothesis tracker; this is a structural-edges-only playbook)
- Attempt latency arb (deferred to post-VPS)

---

## §9 Validation milestones

Goal: rebuild any drawn-down capital using only structural edges, and prove the bot can trade *something* without losing 56% again. Measured weekly.

| Milestone | Target | Measure |
|---|---|---|
| Week 1 | No drawdown | Net PnL ≥ -$5 against $35 starting; no kill-switch events |
| Week 2 | Net positive week | Net PnL > $0 over 7 days; ≥10 closed positions |
| Week 4 | Recover any drawn-down capital | Total capital ≥ pre-blowup level |
| Week 8 | Sustained edge | Cumulative net PnL > 5% of starting capital, max DD < 10% |

If Week 1 shows ANY drawdown beyond fees, halt the bot, revisit §7 checklist, find the parameter that's wrong, fix, restart with reset 7-day clock.

---

## §10 Reference

- Karl Whelan, *Makers and Takers Kalshi paper* (PDF) — https://www.karlwhelan.com/Papers/Kalshi.pdf
- Bartlett & O'Hara, *Adverse Selection in Prediction Markets: Evidence from Kalshi* (Apr 2026) — SSRN 6615739
- `rodlaf/KalshiMarketMaker` post-mortem — https://rlafuente.com/posts/2025-3-5-i-lost-150-market-making-on-kalshi
- `jheusser/vpin` — VPIN reference implementation
- `freqtrade/freqtrade` `IProtection` ABC — risk-gate framework reference
- Aaron Miller, *How to Make Money on Kalshi* — https://4amclub.substack.com/p/how-to-make-money-trading-on-kalshi
