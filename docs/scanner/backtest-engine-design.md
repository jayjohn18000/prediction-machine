---
title: PMCI Backtest Engine Design
tags: [backtest, scanner, three-stage, design, v1]
status: current
last-verified: 2026-05-08
sources:
  - "[[scanner-plan-v1]]"
  - "[[hypothesis-tracker-template]]"
---

# Backtest Engine Design

**Created:** 2026-05-08
**Status:** PLAN — build to follow
**Audience:** anyone building `~/prediction-machine/scripts/backtest/`

---

## §1 Purpose

The backtest engine is the first of three stages in hypothesis validation (backtest → paper → live). It replays historical Kalshi book snapshots through a hypothesis's quoting logic to produce a deterministic, reproducible answer to: *"if this hypothesis had been live for the past 30 days, what would it have made?"*

The backtest is the cheapest stage — costs only compute, no capital. It surfaces obvious problems (negative edge after fees, market regime shifts already baked into the data, capacity issues) before paper or live trading burns calendar time. A hypothesis that loses money in backtest doesn't graduate to paper.

The honest comparison: `backtest +8c → paper +3c (execution drag) → live +1.2c (adverse selection)` tells you whether to scale or retire.

---

## §2 Architecture

```
[provider_market_snapshots]   (~9.2M rows existing)
   ↓ chronological cursor
[Replay engine core]
   ├─ Snapshot iterator
   ├─ State manager (inventory, daily PnL, cooldowns)
   └─ Hypothesis logic application
   ↓
[Quote → fill simulator]
   ├─ Maker fill: market crosses my resting quote
   ├─ Taker fill: my marketable order matches inside
   └─ Fee model: lib/execution/fees.kalshi.mjs
   ↓
[Aggregator]
   └─ Spread capture, adverse selection, fee cost, fill rate
   ↓
[backtest_runs + backtest_fills]
```

---

## §3 Replay engine core

```javascript
// scripts/backtest/run-backtest.mjs
import { loadHypothesis } from '../../lib/scanner/hypotheses.mjs';
import { kalshiFeeUsdCeilCents } from '../../lib/execution/fees.kalshi.mjs';

export async function runBacktest({ hypothesisId, startAt, endAt, marketTicker }) {
  const hypothesis = await loadHypothesis(hypothesisId);
  const runId = await openRun({ hypothesisId, marketTicker, startAt, endAt, paramsSnapshot: serializeParams(hypothesis) });

  const snapshotCursor = await openSnapshotCursor({ marketTicker, startAt, endAt });
  const state = new BacktestState({
    initialCapitalC: hypothesis.sizingRules.test_capital_c,
    minPositionSizeC: hypothesis.minPositionSizeC,
  });

  let snapshot;
  while ((snapshot = await snapshotCursor.next()) !== null) {
    state.updateMarket(snapshot);

    // 1. Apply exit rules to existing positions
    for (const exit of applyExitRules(hypothesis, state, snapshot)) {
      const fill = simulateFill(exit, snapshot, /*conservative=*/ true);
      const fee = kalshiFeeUsdCeilCents(fill);
      await recordFill(runId, fill, fee);
      state.applyFill(fill, fee);
    }

    // 2. Resting orders against new snapshot
    for (const resting of state.restingOrders) {
      if (snapshotCrossesQuote(snapshot, resting)) {
        const fill = simulateFill(resting, snapshot, true);
        const fee = kalshiFeeUsdCeilCents(fill);
        await recordFill(runId, fill, fee);
        state.applyFill(fill, fee);
      }
    }

    // 3. Risk gates per snapshot
    if (state.dailyDrawdown < -0.03) {
      state.haltDay();
      continue;
    }

    // 4. Entry rules → new orders
    if (canEnter(hypothesis, state, snapshot)) {
      const order = computeQuote(hypothesis, state, snapshot);
      state.addRestingOrder(order);
    }
  }

  await closeRun(runId, state);
  return runId;
}
```

---

## §4 Quote simulation

Per snapshot, the engine computes what the hypothesis WOULD have quoted using the same logic the live bot uses. By hypothesis type:

- **Whelan-band (Path 2):** maker order at inside bid for 50–80c band markets, sized per `sizing_rules`.
- **Microstructure structural:** confidence_score from `alpha_miner` port; quote at `mid ± half_spread × sign(confidence)`.
- **Informational lag (NBA):** no resting quotes; taker-on-conviction at `T+30s` post-event when `divergence > 3c`.

`computeQuote()` MUST match the live bot's logic exactly. Apples-to-apples or the comparison lies. Ideally `computeQuote()` is a shared module imported from `lib/mm/`, not a duplicate implementation.

---

## §5 Fill determination

Two fill types:

### 5.1 Maker fill (resting quote crossed by market)

- Order at `bid_price = 0.55` resting since snapshot T.
- Snapshot T+1 has `last_traded_price = 0.55` and `last_traded_side = 'sell'` (someone sold at our bid).
- → Fill at 0.55, side = `buy`, maker = true.

**Queue position is unknown in backtest.** Conservative assumption (default): assume our quote was last in queue, so we fill only if cumulative volume at that price exceeded resting inventory ahead of us. Configurable via `aggressiveFillAssumption: false` (conservative) vs `true` (assume always fill). Conservative is the only honest setting; aggressive is for synthetic stress tests only.

### 5.2 Taker fill (our marketable order)

- Order to take 0.55 ask, size 50.
- Snapshot has `ask = 0.55`, `ask_size = 100`. Full fill at 0.55, side = `buy`, maker = false.
- If `our_size > ask_size`, partial fill + remainder walks the book to next ask level (apply same logic).

---

## §6 Fee model integration

Use existing `lib/execution/fees.kalshi.mjs::kalshiFeeUsdCeilCents`. Apply per-fill, signed by maker/taker side. Fees are negative for taker, can be positive (rebate) for maker. State tracks `fee_net_c` cumulatively.

```javascript
const fee = kalshiFeeUsdCeilCents({
  side: fill.side,
  size: fill.size_c,
  price: fill.price,
  maker: fill.maker,
});
state.applyFee(fee);
```

---

## §7 State management

`BacktestState` class tracks:

| Field | Purpose |
|---|---|
| `cash_c` | signed; decreases on entries, increases on exits + fees |
| `inventory[market_ticker]` | signed contract count per market |
| `restingOrders[]` | orders awaiting fills |
| `dailyPnl` | resets at UTC midnight |
| `dailyDrawdown` | peak-to-trough within day |
| `cooldowns[market_ticker]` | timestamp until which trading paused |
| `haltedToday` | true after -3% daily drawdown |
| `fillHistory[]` | bounded ring buffer for one-sided-fill detection |

State is in-memory during the run; persisted only via `backtest_fills` rows. Memory cap: ~100 markets × ~1k orders × ~50 fills = manageable on t3.micro.

---

## §8 Output schema

Writes via `pmci.backtest_runs` (one row per hypothesis × market × time-window):

```sql
INSERT INTO pmci.backtest_runs (
  hypothesis_id, market_ticker, start_at, end_at, params_snapshot,
  spread_capture_c, adverse_c, fee_net_c, fill_rate, n_quotes, n_fills
) VALUES (...);
```

And `pmci.backtest_fills` (one row per simulated fill):

```sql
INSERT INTO pmci.backtest_fills (
  run_id, snapshot_ts, side, price, size_c, fill_type, pnl_c
) VALUES (...);
```

The three-stage comparison query in `scanner-plan-v1.md` §7 returns:

```sql
SELECT stage, AVG(spread_capture_c), AVG(adverse_c), AVG(fill_rate)
FROM (
  SELECT 'backtest'::text AS stage, ... FROM pmci.backtest_runs WHERE hypothesis_id = :h
  UNION ALL
  SELECT 'paper', ... FROM pmci.mm_pnl_snapshots WHERE hypothesis_id = :h AND mode = 'paper'
  UNION ALL
  SELECT 'live', ... FROM pmci.mm_pnl_snapshots WHERE hypothesis_id = :h AND mode = 'live'
) t GROUP BY stage;
```

---

## §9 Acceptance criteria

A backtest run is **valid** only if:
- `n_quotes ≥ 100` (otherwise statistical significance too low)
- `start_at` to `end_at` spans ≥ 7 days of market activity
- `provider_market_snapshots` has ≥ 1 row per minute on average across the window (data density check)

A hypothesis **passes** backtest validation only if:
- `spread_capture_c - adverse_c - fee_net_c > 0` (net positive after costs)
- Hit rate (fills resolved in predicted direction) > 0.55
- Max single-day drawdown < 15% of test capital

A failed backtest blocks the hypothesis from advancing scanning → testing.

---

## §10 Testing strategy

**Unit tests:**
- `simulateFill()` — maker fill on cross, taker fill on marketable order, no fill on no-cross, partial fill on book walk
- `computeQuote()` — matches `pmci-mm-runtime` quote computation exactly (snapshot fixtures shared across both)
- `kalshiFeeUsdCeilCents()` — covered in existing PMCI tests

**Integration tests:**
- Replay a 7-day window for H-2026-001 (NBA lag hypothesis) end-to-end
- Verify `n_fills > 0` and PnL is bounded (sanity)
- Compare against hand-computed expected outcome on a small synthetic dataset

**Acceptance test:**
- Run backtest on a hypothesis that's already been live in production
- Compare backtest PnL to live PnL — should agree within 30%
- Larger gap means model drift, not backtest error; investigate

---

## §11 Build sequencing

| Week | Deliverable |
|---|---|
| 1 | `BacktestState` class + snapshot cursor + replay loop |
| 1 | `simulateFill()` for maker + taker, conservative queue assumption |
| 2 | Hypothesis logic engine (read entry/exit/sizing JSONB and apply) |
| 2 | Fee model integration + DB writes to `backtest_runs` / `backtest_fills` |
| 3 | Acceptance criteria check + integration test against H-2026-001 |
| 3 | Comparison-vs-live test on a known production hypothesis |

**Total ~3 weeks. Independent of MM redesign and scanner detector work** — can run as its own parallel build stream from week 1.

---

## §12 Operational notes

- Backtest runs are CPU-bound, not IO-bound. Consider running on AWS Ohio t3.micro overnight (cron) rather than competing with live scanner ingestion during the day.
- A 30-day backtest at 1-minute granularity with ~100 markets is roughly 4M snapshot iterations. Memory-bounded if state is well-managed; expect ~5-15 minutes per hypothesis on t3.micro.
- Snapshot cursor should use server-side Postgres cursors (not `LIMIT/OFFSET`) to avoid loading 9M rows into memory.
- Backtest results are append-only — never UPDATE existing rows, always insert new runs. Run IDs let you compare model versions over time.

---

## §13 Reference

- `pmci.provider_market_snapshots` schema in `~/prediction-machine/docs/db-schema-reference.md`
- `lib/execution/fees.kalshi.mjs` — existing fee model (do not reimplement)
- `sf-institutional-alpha-demo/src/sf_institutional_alpha/replay.py` — JSONL replay harness (port concepts to Node)
- `lib/mm/orchestrator.mjs` — quote computation logic to be shared between backtest and live (refactor to extract pure functions)

## §14 Cross-references

- `~/prediction-machine/docs/scanner/scanner-plan-v1.md` §7 — three-stage flow (backtest → paper → live)
- `~/prediction-machine/docs/scanner/scanner-output-design.md` — `pmci-hypothesis backtest` CLI invocation
- `~/prediction-machine/docs/strategies/hypothesis-tracker-template.md` §4.2 — scanning → testing posture (backtest is one of the gates)
- `~/prediction-machine/docs/strategies/mm-runtime-redesign-v2.md` §6.2 — shared `computeQuote()` module
