---
title: MM v2 — Backtest engine specification (replay + calibration)
status: draft
last-verified: 2026-05-01
sources:
  - supabase/migrations/20260424120004_pmci_provider_market_depth.sql
  - supabase/migrations/20260428100001_pmci_mm_w2_schema.sql
  - docs/plans/phase-mm-mvp-plan.md
  - docs/plans/phase-poly-wallet-indexer-plan.md
  - lib/execution/fees.kalshi.mjs
  - /Users/jaylenjohnson/audits/post-pivot-review/synthesis/post-pivot-roadmap.md
  - /Users/jaylenjohnson/audits/post-pivot-review/synthesis/cross-cutting-findings.md
  - docs/decision-log.md
---

# MM backtest engine specification

## 1. Goal

Replace archived **arb-directional** `lib/backtest/*` (Track B archival per `post-pivot-roadmap.md` §5) with an **MM-specific** simulator that:

1. Replays quoting decisions against historical **Kalshi depth** snapshots.
2. Simulates fills with an **aggregated trade-print** model (Kalshi tapes — **precondition**, not ingested today).
3. Computes **adverse selection** costs from realized post-trade mid paths (same attribution spirit as live `mm_fills`).

**Primary acceptance test:** Replay of the **completed 7-day validation window** (ADR-008 clock, superseded-universe semantics per ADR-010) reproduces **`pmci.mm_pnl_snapshots` within ±5% per market per day** on attribution columns listed below.

---

## 2. Input data sources

| Source | Status today | Role in engine |
|--------|---------------|----------------|
| `pmci.provider_market_depth` | ✅ Migr. `20260424120004_pmci_provider_market_depth.sql` | L2 ladders → mid, spread, queue position proxy |
| `pmci.mm_orders` / `pmci.mm_fills` | ✅ (live test) | Optional ground-truth calibration of dispatch timing |
| **Kalshi trade prints / tape** | **Not yet — precondition** | Probabilistic fill model when our resting orders cross trade flow |
| `pmci.poly_market_flow_5m` + trades | ⚠️ Schema only until indexer **W3–W5** | Optional realism layer for preemptive cancel (not MVP for engine v0) |

---

## 3. Core simulation loop

**Per enabled market × time step Δt (≤1s aligned to stored downsampler cadence):**

1. Build Kalshi snapshot at $t$: best YES bid, derived YES ask, midpoint, spread.
2. Load config row (`mm_market_config` analogue in sim): spreads, skew, toxicity thresholds, **`fair_value_version`** (future).
3. Compute quotes via same pure functions as live (`decideQuote` family) seeded with reconstructed inventory.
4. **Fill model:**
   - If tape available: Bernoulli / Poisson hit on our quoted prices using empirical trade clustering by price level.
   - Until tape lands: **conservative precondition** — use depth-derived “trade-through” heuristic (simulate aggressor arrivals as thinning of opposing best size at Poisson rate fit from spreads) flagged as lower confidence.
5. On synthetic fill at price $p$, compute **immediate** attribution components identical to Contract R7 writer (spread capture vs mid at place, fee estimate via `lib/execution/fees.kalshi.mjs::kalshiFeeUsdCeilCents` pathway).
6. **Adverse selection:** Replay forward mid from historical depth at $t+60s,+300s,+1800s$ (mirrors toxicity windows in `pmci.mm_fills`).

---

## 4. Output schema — must match `mm_pnl_snapshots`

Migr. `20260428100001_pmci_mm_w2_schema.sql`:

| Column | Engine requirement |
|--------|---------------------|
| `market_id` | bigint FK |
| `observed_at` | bucket alignment (UTC, same cadence as live writer; recommend 5m) |
| `spread_capture_cents` | ✅ |
| `adverse_selection_cents` | ✅ |
| `inventory_drift_cents` | ✅ |
| `fees_cents` | ✅ |
| `net_pnl_cents` | ✅ |

Engine must populate **the same decomposition definitions** documented for Contract R7 (no semantic drift versus live cron writer). Any approximation must carry `confidence` meta in auxiliary JSON table (future) — not in canonical snapshot columns.

---

## 5. Calibration vs validation — **day-2 anomaly**

Operational fact (**CLAUDE.md**, **ADR-008/010** context): daily-loss breach & **44k-class `daily_loss` kill_switch storm** mid-test.

Define two distinct uses of history:

| Mode | Uses day-2 data? | Purpose |
|------|------------------|---------|
| **Hyperparameter fitting** (fill intensities, cancel latency knobs) | **Out-of-sample (exclude)** | Day-2 is **regime-shifted** (risk saturation, kill-switch churn). Fitting inside it biases parameters toward crisis microstructure not representative of normal DEMO MM. |
| **Ledger reconciliation validation** | **In-sample (include)** | The ±5%/market/day criterion is **reproduction of observed `mm_pnl_snapshots`**, inclusive of turmoil. Simulator must replicate day-2 **if** fed the same exec/risk traces; failure indicates engine gap, not “drop the day”. |

Explicit statement requested by Track C brief: **day-2 is out-of-sample for calibration (parameter fitting)** and **in-sample for acceptance testing against realized ledger rows**. If replay cannot hit ±5% on day-2 without overfitting knobs, escalate to operator: either widen tolerance for crisis days **or** model kill-switch suppressing quotes as a discrete state machine.

---

## 6. Adverse-selection simulation fidelity

Leverage archived MM plan intent (`phase-mm-mvp-plan.md`, `lib/mm/toxicity.mjs`): compare **fair value at fill/placement time** vs post-fill mids. Align with **`mm_fills.adverse_cents_5m`** side-aware semantics (R3: not naive generated column).

When historical depth gaps exist after a fill timestamp, carry last mid forward with staleness flags; engine should log **`depth_gap`** counts per market-day for quality scoring.

---

## 7. Sequencing — dependency on indexer weeks

| Poly indexer milestone (`phase-poly-wallet-indexer-plan.md` Build sequence) | MM backtest dependency |
|----------------------------------------------------------------------------|-------------------------|
| W1 schema | No hard dependency (MM depth sufficient for v0). |
| W2 historical trades | Optional cross-venue context; **not** on critical path for Kalshi-only fill model. |
| W3 live tail | Needed only if simulating **preemptive cancel** from sharp flow. |
| W4 nightly stats | Sharp wallet priors for scenario analysis. |
| W5 flow rollups + NOTIFY | Full **F7 / toxicity-aware** quote path backtest (second-stage spec). |

**Kalshi trade-print ingestion** is **orthogonal** to Poly weeks — highest priority **precondition** for fill realism.

---

## 8. Non-goals (v0 spec)

- Sub-millisecond latency modeling (per MVP plan out-of-scope).
- Polymarket execution or inventory.
- Automatic parameter search without operator-approved bounds (avoids DEGRADER **#3** ambiguity on attribution).

---

## 9. Audit cross-links

Hidden serial dependency (`post-pivot-roadmap.md` §4): ≥7 days depth history needed — same clock as live test.

DEGRADER **#8** (`provider_market_depth` retention): backtest must pin **retention policy** so replays are reproducible months later.

Cross-cutting remainder bullet (*Trader interface missing `getFills`*): live reconciliation quality influences how closely sim fill times match reality (`cross-cutting-findings.md` §4 remainder list).

### DEGRADER remainder ranks #14, #15, #20, #28 (extended table)

Per `cross-cutting-findings.md` §4 remainder list (continuing after top-10 ranks):

| Rank | Finding | Backtest implication |
|------|---------|----------------------|
| **#14** | Position-state cache vs DB-roundtrip unspecified | Simulator must branch **both** modes or pin live orchestrator behavior explicitly. |
| **#15** | Daily-loss reset semantics undefined | Replay must codify reset boundary or cannot match live kill-switch / PnL day buckets. |
| **#20** | Fly rolling-deploy dual-instance window undocumented | Optional stress scenario for overlapping-quote microseconds during deploy. |
| **#28** | Indexer schema fitness at ~15M rows/yr | Relevant when Poly trade history feeds the sim at scale (partitioning parity). |
