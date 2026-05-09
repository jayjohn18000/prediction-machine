# Phase 0 / Stream E — Final Report (Backtest engine + `computeQuote` refactor)

**Status:** `READY` for code review and operator merge **with acceptance runs BLOCKED on data** until `pmci.hypotheses` contains the target rows (see below).

## Branch

- **Branch:** `phase-0/stream-e-backtest-engine` (pushed for operator review; **no PR** per brief).
- **Stream A gate:** Treated as **READY** per operator instruction (`pmci.backtest_runs` / `pmci.backtest_fills` present on DB probe; `mm_pnl_snapshots` has `hypothesis_id` + `mode`).

## What shipped

1. **`lib/mm/compute-quote.mjs`** — Pure `deriveVolSpreadCents`, `computeQuote`, `computeQuoteFromState` (fair-value + `decideQuote` path shared with replay).
2. **`lib/mm/orchestrator.mjs`** — Live tick path calls `computeQuote(...)`; carry shape unchanged (`fvCarry` / `fair_value_cents` / quote object).
3. **`lib/backtest/`** — `BacktestState`, keyset snapshot pagination, fill simulator, hypothesis-shaped quote derivation, `runBacktest`, `runBacktestNightly`.
4. **CLI:** `scripts/backtest/run-backtest.mjs` (`--hypothesis`, `--start`, `--end`, `--market`, optional `--compare-live`); `scripts/backtest/run-backtest-nightly.mjs`.
5. **Ops:** `POST /v1/admin/jobs/scanner-backtest-nightly` (in-process, Pattern 4); `pmci-job-runner` map key `scanner-backtest-nightly`; pg_cron `pmci-scanner-backtest-nightly` at **04:30 UTC** (`supabase/migrations/20260509140000_pmci_scanner_backtest_nightly_cron.sql`).
6. **Tests:** `test/mm/compute-quote-refactor.test.mjs`, `test/backtest/fill-sim.test.mjs`.

Fees / spread capture in the engine use **`kalshiFeeCentsForMmFill`** and **`spreadCaptureCentsForFill`** from `lib/mm/pnl-attribution.mjs` so replay matches live R7-style attribution, not a separate fee reimplementation.

## Verification run (local)

```bash
node --test test/mm/compute-quote-refactor.test.mjs test/backtest/fill-sim.test.mjs
node -e "import('./src/routes/admin-jobs.mjs').then(() => console.log('admin-jobs ok'))"
```

All passed in the agent session.

## H-2026-001 7-day acceptance

**BLOCKED ON:** `SELECT id FROM pmci.hypotheses` returned **no rows** on the configured `DATABASE_URL` (same connection used to confirm `pmci.backtest_runs` exists). Without a hypothesis row, `runBacktest` throws at load and **cannot** emit `n_quotes`, density, or PnL.

**Operator unblock:** Insert or seed `pmci.hypotheses` (including `H-2026-001` per strategy template), then run e.g.:

```bash
node scripts/backtest/run-backtest.mjs \
  --hypothesis H-2026-001 \
  --start <iso> \
  --end <iso> \
  --market <kalshi_ticker_with_dense_snapshots>
```

## Comparison vs live (§7-style)

**BLOCKED** for the same reason: no hypothesis id to join, and no guarantee of overlapping `mm_pnl_snapshots` windows until a live `hypothesis_id` is populated.

CLI helper: add `--compare-live` to the run-backtest command; it averages `spread_capture_cents` / `adverse_selection_cents` from `mm_pnl_snapshots` (`mode = 'live'` when column exists) vs `spread_capture_c` / `adverse_c` from `pmci.backtest_runs`, and reports a **within 30%** flag on spread capture when the live average is non-zero.

## Merge coordination (Stream D)

Stream D may edit `lib/mm/orchestrator.mjs` (pre-place hook). **This stream’s load-bearing change is the `computeQuote` extraction and call site** around the fair-value + `decideQuote` block. On conflict, keep the shared helper and re-apply Stream D logic around it; resolve with the operator.

## Pattern 4 (cron → writer)

After `db push` of the new migration and deploy of `pmci-api` **with** the in-process job handler, confirm **`pmci.backtest_runs`** rows appear after the 04:30 UTC window (or trigger `scanner-backtest-nightly` once manually). Cron alone is not sufficient if the Fly app does not run the new route.

## Commit

After push, record: `git log -1 --oneline` on `phase-0/stream-e-backtest-engine`.

---
*Generated per `.cursor-prompts/phase-0/05-stream-e-backtest-engine.md`.*
