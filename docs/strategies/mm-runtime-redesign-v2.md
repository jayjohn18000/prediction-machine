---
title: pmci-mm-runtime Redesign — v1 Patch + v2 Rewrite
tags: [mm, redesign, bot, architecture, vpin, glosten-milgrom, iprotection]
status: current
last-verified: 2026-05-08
sources:
  - "[[scanner-plan-v1]]"
  - "[[hypothesis-tracker-template]]"
  - "[[published-edges-playbook]]"
  - "[[2026-05-06-mm-philosophy-pivot]]"
---

# pmci-mm-runtime Redesign

**Created:** 2026-05-08
**Status:** PLAN — build to follow review
**Audience:** anyone touching `~/prediction-machine/lib/mm/`

---

## §1 Purpose & scope

The existing `pmci-mm-runtime` (Fly app, Node.js, single-instance) ran a symmetric Avellaneda-Stoikov maker on Kalshi MLB single-name markets from 2026-05-02 to 2026-05-06 and lost 56% of capital. Failure mode: textbook adverse selection on trending sports books — bot priced from `mid` (lagging), quoted symmetrically, and had no toxicity gate.

This document specifies the redesign in two phases:

- **v1 patch** layered on the existing A-S kernel — re-arms the bot safely in ~1 week
- **v2 rewrite** replacing fair-value with a Glosten-Milgrom Bayesian posterior — ~3 weeks after v1 stable

Scope:
- IN — bot architecture from market subscription through order placement; v1 patch components; v2 rewrite components; schema additions; build sequencing; testing
- OUT — scanner detection logic (`scanner-plan-v1.md`), hypothesis state machine (`hypothesis-tracker-template.md`), pre-arm parameter audit (`published-edges-playbook.md` §7)

---

## §2 Failure mode recap

Three structural choices were independently survivable but collectively fatal:

1. **Symmetric quoting** (`bid = fair − 1c`, `ask = fair + 1c`). Theory (Glosten-Milgrom 1985) requires `bid = E[V | sell-trade]`, `ask = E[V | buy-trade]` — Bayesian update on every fill. Symmetric quotes violate the update.
2. **Mid-as-fair-value**. On a trending sports book, mid is *lagging*. Sharp money harvests the entire information increment per fill.
3. **Continuous-quoting goal** (`uptime ≥ 90%` per ADR-013). The math rewards *withdrawing* liquidity when flow is one-sided. Treating uptime as the objective is structurally inverted.

Per Bartlett & O'Hara (Apr 2026 Kalshi paper, 41.6M trades), single-name sports markets exhibit greater informed price impact than broad-based markets, and one-sided order flow predicts maker losses there. No retail YES-overbetting subsidy on in-play sports — adverse selection is uncompensated.

---

## §3 Redesign principles

1. **Stop "always be quoting." Start "selectively quote when toxicity is low; take when conviction is high; pull when flow is one-sided."**
2. **Fair value is a posterior, not a midpoint.** Update on every fill and external signal.
3. **Risk gates fire BEFORE loss accrues, not after.** Pre-trade adjust, not post-trade halt.
4. **Layered defenses.** Multiple independent gates, no single point of failure.
5. **Schema-enforced limits.** When the database refuses an order, the application doesn't have to be perfect.

---

## §4 v1 patch (~1 week)

Layer four new components on the existing A-S kernel without rewriting it.

### 4.1 VPIN toxicity gate

Port `jheusser/vpin` 30-line core to Node.js. Compute VPIN per ticker from `mm_orders` + Kalshi trade prints in volume-time buckets.

```javascript
// lib/mm/toxicity/vpin.mjs
export function computeVpin(trades, bucketSize, windowSize) {
  const buckets = bucketByVolume(trades, bucketSize);
  const recent = buckets.slice(-windowSize);
  const oi = recent.map(b => Math.abs(b.buys - b.sells) / bucketSize);
  return mean(oi);
}

export function shouldPullQuotes(vpin, threshold = 0.7) {
  return vpin > threshold;
}
```

When `VPIN > 0.7`, pull quotes for 60s. Catches the toxic-flow signature that took down MINWSH.

### 4.2 Game-state pull gate (hoopR integration)

For NBA markets in the bot's allowlist, poll cdn.nba.com play-by-play every 3-5s. Compute `dWP/dt` from hoopR coefficients. When `|dWP/dt|` spikes above rolling 30-day p75 during scoring plays / timeouts / late-game high-leverage spots, pull quotes for 60s. Same signal the scanner uses to detect informational lag (`scanner-plan-v1.md` §5.1) — the bot uses it defensively.

```javascript
// lib/mm/gates/game-state.mjs
export async function gameStatePullCheck(market) {
  if (!market.allowlist.includes('nba_in_play')) return false;
  const events = await fetchPlayByPlay(market.gameId);
  const wpaThreshold = await getWpaP75ForLast30Days(market.teamPair);
  const recentWpa = computeRecentWpa(events, hoopR.coefficients);
  return Math.abs(recentWpa) > wpaThreshold;
}
```

### 4.3 IProtection layered gates (Freqtrade pattern)

Port Freqtrade's `IProtection` ABC. Each protection is a class with `globalStop()`, `stopPerMarket()`, `stopPerSide()`. Protections compose in the orchestrator's pre-place hook.

```javascript
// lib/mm/risk/protections/IProtection.mjs
export class IProtection {
  globalStop(state) { return false; }
  stopPerMarket(state, marketTicker) { return false; }
  stopPerSide(state, marketTicker, side) { return false; }
}

// lib/mm/risk/protections/MaxDrawdownLadder.mjs
export class MaxDrawdownLadder extends IProtection {
  globalStop(state) {
    const dd = computeDrawdown(state);
    if (dd <= -0.03) return { stop: 'halt', reason: 'drawdown_3pct' };
    if (dd <= -0.02) return { stop: 'one_sided_flatten', reason: 'drawdown_2pct' };
    if (dd <= -0.01) return { stop: 'halve_size', reason: 'drawdown_1pct' };
    return false;
  }
}

// lib/mm/risk/protections/CooldownAfterOneSidedFills.mjs
export class CooldownAfterOneSidedFills extends IProtection {
  stopPerMarket(state, marketTicker) {
    const recent = state.recentFills(marketTicker, 10);
    if (recent.length >= 3 && recent.slice(0, 3).every(f => f.side === recent[0].side)) {
      return { stop: 'cooldown_10min', reason: 'three_same_side_fills' };
    }
    return false;
  }
}
```

Five protections in v1: `MaxDrawdownLadder`, `CooldownAfterOneSidedFills`, `PerMarketLossCap`, `LatencyGate`, `KillSwitchOnDailyLoss`.

### 4.4 Pre-trade adjust (Hummingbot BudgetChecker pattern)

Every order is **adjusted before submission**, not blocked after. Reduce size if needed; reject only if size would fall below `min_position_size_c`.

```javascript
// lib/mm/risk/budget-checker.mjs
export function adjustCandidate(order, state, protections) {
  const remaining = state.dailyBudgetRemaining();
  if (remaining <= 0) return null;
  if (order.size_c > remaining) {
    order.size_c = Math.max(remaining, MIN_POSITION_SIZE_C);
    order.adjustedReason = 'budget_remaining';
  }
  for (const p of protections) {
    const result = p.globalStop(state) || p.stopPerMarket(state, order.market_ticker);
    if (result?.stop === 'halt') return null;
    if (result?.stop === 'halve_size') order.size_c = Math.floor(order.size_c / 2);
    if (result?.stop === 'one_sided_flatten') order.side = state.flattenSide(order.market_ticker);
    if (result?.stop === 'cooldown_10min') return null;
  }
  if (order.size_c < MIN_POSITION_SIZE_C) return null;
  return order;
}
```

### 4.5 v1 patch summary

| Component | Source pattern | Effort |
|---|---|---|
| VPIN gate | `jheusser/vpin` (~30 LOC port) | 2 days |
| Game-state pull (hoopR) | scanner detector code reuse | 2 days |
| IProtection ladder | `freqtrade/freqtrade` ABC | 2 days |
| Pre-trade adjust | `hummingbot` BudgetChecker | 1 day |

**Total ~1 week.** Result: bot re-armable for Path 2 + scanner-driven trades with structural defenses against the failure mode that took it down.

---

## §5 v2 rewrite (~3 weeks, after v1 stable)

Replace lagging mid-as-fair-value with Glosten-Milgrom Bayesian posterior. Structural fix; v1 patch keeps bot alive while v2 is built.

### 5.1 Glosten-Milgrom posterior

Port `nickchuisme/glosten-milgrom` `make_price()`. Kalshi binaries map 1:1 to GM's V_LOW / V_HIGH state space (V_LOW = 0¢, V_HIGH = 100¢ — literal correct math, not metaphor).

```javascript
// lib/mm/fair-value/glosten-milgrom.mjs
export class GMPosterior {
  constructor({ priorBelief = 0.5, informedFraction = 0.3 }) {
    this.delta = priorBelief;       // P(V = V_LOW)
    this.mu = informedFraction;     // VPIN-derived
    this.gamma = 0.5;               // uninformed buy-bias prior
  }

  fairValue() {
    return 1.0 * (1 - this.delta) + 0.0 * this.delta;
  }

  bidPrice() { return this.fairValueGivenAction('sell'); }
  askPrice() { return this.fairValueGivenAction('buy'); }

  fairValueGivenAction(action) {
    const post = this.posteriorAfter(action);
    return 1.0 * (1 - post) + 0.0 * post;
  }

  posteriorAfter(action) {
    if (action === 'buy') {
      const num = (1 - this.delta) * (this.mu + (1 - this.mu) * this.gamma);
      const den = this.delta * (1 - this.mu) * this.gamma + num;
      return 1 - num / den;
    } else {
      const num = (1 - this.delta) * (1 - this.mu) * (1 - this.gamma);
      const den = this.delta * (this.mu + (1 - this.mu) * (1 - this.gamma)) + num;
      return 1 - num / den;
    }
  }

  updateOnFill(side) {
    this.delta = this.posteriorAfter(side === 'buy' ? 'buy' : 'sell');
  }
}
```

`mu` (informed fraction) set dynamically from VPIN: `mu = clamp(vpin, 0.1, 0.9)`. High VPIN → more flow treated as informed → wider posterior gap between bid and ask.

### 5.2 Taker-on-conviction

When `|GMPosterior.fairValue() - book.mid()| > 0.03` (3c divergence), submit a marketable taker order instead of resting a quote. Replaces "always quote" with "take when conviction is high."

### 5.3 Inventory skew (corrected per rodlaf bug 1)

```
reservation_price = mid - q * gamma * sigma^2 * (T - t)
half_spread = gamma * sigma^2 * (T - t) + (2/gamma) * ln(1 + gamma/kappa)
```

- `q` = current inventory (signed)
- `gamma` = risk aversion (start at 0.1)
- `sigma` = volatility (binary [0,1] markets: **0.05–0.15**, NOT crypto's 0.001 — rodlaf bug 3)
- `kappa` = order arrival intensity (calibrate from historical fills)
- `(T - t)` = time to settlement, fraction-of-day

Property test: `q = +10` → `reservation_price < mid`; `q = -10` → `reservation_price > mid`.

---

## §6 Component-by-component design

### 6.1 Architecture overview

```
External market data           Internal state
   ↓                              ↓
[Kalshi WS subscriber] → [Order book mirror]
[NBA cdn.nba.com poll] → [Game state cache]
[Scanner alert webhook subscriber] → [Active signals cache]
   ↓
[Fair value engine]
   ├─ v1: existing A-S kernel
   └─ v2: GM posterior
   ↓
[Quote engine]
   ├─ Reservation price + half-spread (A-S)
   ├─ Taker-on-conviction (v2)
   └─ Inventory skew correction
   ↓
[Risk gate chain]   (composed protections)
   ├─ VPIN toxicity gate → pull 60s if > 0.7
   ├─ Game-state pull gate → pull 60s on |dWP/dt| spike
   ├─ MaxDrawdownLadder → halve / one-sided / halt
   ├─ CooldownAfterOneSidedFills → 10-min per-market
   ├─ PerMarketLossCap → halt market
   ├─ LatencyGate → pull if WS lag > N
   ├─ KillSwitchOnDailyLoss → halt all
   └─ BudgetChecker → adjust size pre-submit
   ↓
[Order submitter]
```

### 6.2 Module map

| Path | Phase | Purpose |
|---|---|---|
| `lib/mm/orchestrator.mjs` | existing | modify pre-place hook to call risk chain + scanner alerts |
| `lib/mm/fair-value/avellaneda-stoikov.mjs` | existing | keep for v1, retire when v2 ships |
| `lib/mm/fair-value/glosten-milgrom.mjs` | **new v2** | GM posterior |
| `lib/mm/toxicity/vpin.mjs` | **new v1** | VPIN computation |
| `lib/mm/gates/game-state.mjs` | **new v1** | hoopR-driven pull gate |
| `lib/mm/risk/protections/IProtection.mjs` | **new v1** | ABC for protection plugins |
| `lib/mm/risk/protections/MaxDrawdownLadder.mjs` | **new v1** | drawdown ladder |
| `lib/mm/risk/protections/CooldownAfterOneSidedFills.mjs` | **new v1** | one-sided lockout |
| `lib/mm/risk/protections/PerMarketLossCap.mjs` | **new v1** | per-market halt |
| `lib/mm/risk/protections/LatencyGate.mjs` | **new v1** | WS-lag-based pull |
| `lib/mm/risk/protections/KillSwitchOnDailyLoss.mjs` | **new v1** | global daily halt |
| `lib/mm/risk/budget-checker.mjs` | **new v1** | pre-trade adjust |
| `lib/mm/scanner-subscriber.mjs` | **new v1** | webhook subscriber from scanner alerts |

---

## §7 Schema additions

Most schema lives in `scanner-plan-v1.md` §8. MM-specific additions:

```sql
-- VPIN state per ticker
CREATE TABLE pmci.mm_vpin_state (
  market_ticker   text PRIMARY KEY,
  computed_at     timestamptz NOT NULL DEFAULT now(),
  vpin_value      numeric(5,4) NOT NULL,
  bucket_size_c   int NOT NULL,
  window_buckets  int NOT NULL,
  is_pulled       boolean NOT NULL DEFAULT false,
  pulled_until    timestamptz
);

-- Protection state (composed gates)
CREATE TABLE pmci.mm_protection_state (
  id              bigserial PRIMARY KEY,
  protection_name text NOT NULL,
  market_ticker   text,
  scope           text NOT NULL CHECK (scope IN ('global','per_market','per_side')),
  fired_at        timestamptz NOT NULL DEFAULT now(),
  reason          text NOT NULL,
  action          text NOT NULL CHECK (action IN ('halve_size','one_sided_flatten','halt','cooldown_10min')),
  expires_at      timestamptz,
  resolved_at     timestamptz
);

-- GM posterior per market (v2)
CREATE TABLE pmci.mm_gm_posterior_state (
  market_ticker   text PRIMARY KEY,
  delta           numeric(5,4) NOT NULL,
  mu              numeric(5,4) NOT NULL,
  fair_value      numeric(5,4) NOT NULL,
  last_fill_at    timestamptz,
  last_fill_side  text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Per-market config extension
ALTER TABLE pmci.mm_market_config
  ADD COLUMN allowlist_categories text[] DEFAULT '{}',
  ADD COLUMN vpin_threshold numeric(4,3) DEFAULT 0.7,
  ADD COLUMN game_state_pull_enabled boolean DEFAULT false,
  ADD COLUMN max_drawdown_pct_global numeric(4,3) DEFAULT 0.03,
  ADD COLUMN cooldown_after_consecutive_same_side int DEFAULT 3,
  ADD COLUMN gm_posterior_enabled boolean DEFAULT false;
```

---

## §8 Build sequencing

### v1 patch

| Week | Deliverable |
|---|---|
| 1 | VPIN module + `mm_vpin_state` + cron updating per-ticker VPIN |
| 1 | Game-state pull gate hooked into orchestrator pre-place |
| 2 | IProtection ABC + 5 protection plugins + `mm_protection_state` |
| 2 | Pre-trade adjust BudgetChecker integration |
| 2 | 48h paper-mode smoke test (`MM_RUN_MODE=paper`) |
| 3 | Re-arm in test mode at 25% capital allocation |
| 3-4 | Scale to 100% if criteria met (per `published-edges-playbook.md` §9) |

### v2 rewrite (after v1 stable)

| Week | Deliverable |
|---|---|
| 5 | GM posterior module + `mm_gm_posterior_state` |
| 5 | Bayesian update on every fill |
| 6 | Taker-on-conviction integration (3c divergence threshold) |
| 6 | 48h paper-mode v2 smoke test |
| 7 | v2 turn-on per-market via `mm_market_config.gm_posterior_enabled` flag |

---

## §9 Testing strategy

**Property tests (mandatory before any deploy)** — listed as the rodlaf-bug pre-arm checklist in `published-edges-playbook.md` §7.1, repeated here for build-side reference:

1. `q = +10` → `reservation_price < mid`; `q = -10` → `reservation_price > mid` (rodlaf bug 1)
2. `compute_half_spread(any_valid_state) > 0` (rodlaf bug 2)
3. `sigma_estimator(historical_kalshi_prices)` returns value in `[0.05, 0.15]` (rodlaf bug 3)
4. `score(narrow_spread_market) > score(wide_spread_market)` holding all else equal (rodlaf bug 4)
5. MVE / scalar-strike markets blocklist intersection with rotator output is empty (rodlaf bug 5)
6. `per_trade_size × max_concurrent_positions ≤ total_capital × 0.5` (rodlaf bug 6)

**Integration tests:**
- Replay 30 days of historical data through the new pipeline; compare to v1 PnL
- Inject synthetic VPIN spike → verify quotes pulled for exactly 60s
- Inject synthetic 3c divergence → verify taker-on-conviction submits
- Inject -3% drawdown → verify halt triggers

**Acceptance criteria for v1 patch deploy:**
- All 6 property tests pass in CI
- 48h paper-mode shows no exception in orchestrator log
- VPIN gate fired ≥1× in paper testing without bot crash
- IProtection gates fired correctly in synthetic injection tests
- Operator sign-off in `decision-log.md` as ADR

---

## §10 Operational notes

- `pmci-mm-runtime` remains single-instance (`fly scale count 1`); two orchestrators would double-quote and corrupt inventory.
- Pause via `fly scale count 0 -a pmci-mm-runtime`.
- All env vars must sync between `pmci-api` (which spawns rotator subprocess) and `pmci-mm-runtime` (which runs orchestrator). `MM_RUN_MODE` in particular.
- Per CLAUDE.md invariants: PROD-only since 2026-05-02 ADR-012. Never invoke rotator with `--mode=demo`. If a PROD path errors, fix the PROD path.
- Single-account, multi-strategy attribution: every order tagged with `hypothesis_id` per scanner-plan-v1.md `mm_orders` ALTER. Per-strategy PnL computed from local DB, never from Kalshi dashboard.

---

## §11 Reference repos

- `jheusser/vpin` — VPIN reference (Python, Bitcoin order flow). Port to Node, ~30 LOC.
- `nickchuisme/glosten-milgrom` — sequential Bayesian MM. Port `make_price()` directly; binary state-space maps to Kalshi.
- `freqtrade/freqtrade` — `IProtection` ABC, `lock_pair()` DB persistence, composable protections.
- `hummingbot/hummingbot` — `BudgetChecker.adjust_candidate()` pre-trade adjust.
- `Polymarket/poly-market-maker` — `BaseStrategy` interface for v2 strategy abstraction.
- `rodlaf/KalshiMarketMaker` post-mortem — 6 specific Kalshi A-S parameter bugs.

## §12 Cross-references

- `~/prediction-machine/docs/scanner/scanner-plan-v1.md` — scanner architecture (compositor outputs feed bot via webhook)
- `~/prediction-machine/docs/strategies/hypothesis-tracker-template.md` — hypothesis state machine (alerts gate by hypothesis status)
- `~/prediction-machine/docs/strategies/published-edges-playbook.md` — pre-arm checklist (mandatory before re-enable)
- `~/prediction-machine/docs/research/2026-05-06-mm-philosophy-pivot.md` — original failure analysis
- `~/prediction-machine/CLAUDE.md` — repo invariants
