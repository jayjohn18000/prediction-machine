# Agent A5 — Backtest Engine

_Read `docs/pivot/north-star.md`, `docs/pivot/dependency-map.md`, and `docs/pivot/success-rubric.md` before starting. You are the capstone agent. You produce the scoreboard the whole pivot is designed to produce._

## Why this work matters

A1 gives us outcomes. A2 gives us costs. A3 gives us quality-filtered families. You turn those three inputs plus the 1.4M+ historical snapshot rows into the single deliverable the pivot exists to produce: a ranked per-family net-P&L table.

Every claim about whether PMCI can make money — every prior, every instinct, every roadmap phase — gets settled by your output. You are not producing an analysis. You are producing the ledger the project has never had.

## What success looks like

- An engine (suggested: `scripts/backtest/run-backtest.mjs`) that, given the linked-family universe and the artifacts from A1, A2, A3, emits a ranked per-family table with the columns specified in `success-rubric.md`:
  - `family_id`, `sport`, `category`, `trades_simulated`, `win_rate`, `mean_net_edge_per_100`, `total_pnl_history`, `median_hold_days`, `resolution_equivalence`.
- The table is saved to a file (CSV or Parquet) and is also readable from a lightweight SQL view or table for ad-hoc querying.
- The engine is deterministic: running it twice on the same inputs produces identical output.
- The engine is re-runnable: when A1 refreshes outcomes, or A2 adjusts cost assumptions, a single command regenerates the ranked table.
- A short interpretation document accompanies the first full run, applying `success-rubric.md` and stating whether the decision zone is GREEN, YELLOW, or RED.

## The entry-detection philosophy

The hardest judgment call in the engine is "when would we have entered a trade?" Some options:

- **Every snapshot where spread ≥ threshold:** maximally optimistic (assumes every edge moment was catchable).
- **Only snapshots where spread ≥ threshold AND held for N consecutive snapshots:** more realistic (edge has to persist long enough to notice and act).
- **Spread ≥ threshold at a time-sampled interval (e.g., once per hour):** models a polling trading loop realistically.

v1 choice: implement the time-sampled entry model (hourly or similar), and make the interval configurable. Document the assumption. Running the backtest under multiple entry models and comparing is a useful follow-on; for the go/no-go decision, one defensible model is enough.

Do not implement an entry model that assumes perfect snapshot-level catching unless you can argue honestly that the live system will do that. It almost certainly won't.

## The holding-to-resolution model

v1 assumption: both legs are opened at detected-entry-time prices and held to resolution. No mid-trade exits, no re-hedging, no averaging in. P&L is `(payoff_from_winning_side - 1.0) - (loss_from_losing_side) - costs` per $1 notional.

This is a simplification. Real arbitrage may exit early if the spread collapses, or if one side's liquidity drains. v1 ignores early-exit optionality. Document this clearly — it's a conservative assumption in most cases (leaving money on the table), not an optimistic one.

## Scope boundaries

**In scope:**
- The engine producing the ranked table.
- Integration with A1 outcomes, A2 cost function, A3 equivalence filter.
- Deterministic, re-runnable execution.
- An interpretation document applying `success-rubric.md` to the first run.

**Out of scope:**
- Live shadow trading. The pivot replaced that with this historical backtest.
- A web UI on top of the ranked table. A CSV is enough for the decision. UI is a follow-on.
- Exotic entry/exit models beyond v1. If v1 produces actionable output, v2 refinements are a post-pilot exercise.
- Per-family parameter tuning to inflate apparent edge. The engine uses one set of parameters uniformly; per-family tuning is overfitting and will not transfer to live.

## The overfitting trap

This is the failure mode to watch hardest. If you run the backtest, see a weak result, and tune entry thresholds / hold models / slippage assumptions until the output looks GREEN, you have not proven edge — you have proven you can find a set of parameters that fits the past. Those parameters will not work live.

Rule: v1 parameters are chosen *before* seeing the ranked output. If the first output is RED, that is the answer. Tuning is allowed only with explicit owner sign-off and only when the tuning is justified by a defensible model correction (e.g., "fees were actually 0.5% lower than I initially coded"), not by output-chasing.

## What "done" requires you to prove

1. The engine runs end-to-end using real A1 outcomes, real A2 costs, and real A3 equivalence filter — no mocks in the final run.
2. Two consecutive runs on the same inputs produce byte-identical output.
3. The interpretation document classifies the result as GREEN / YELLOW / RED per the rubric, with rationale.
4. The ranked table is queryable by family_id and sortable by `mean_net_edge_per_100` and `total_pnl_history` without post-processing.
5. A sanity check: at least one family with obvious historical spread gets a sensible non-zero P&L, and at least one family where you expect no edge gets ~zero. If those sanity checks fail, the engine is buggy.

## Things to escalate

- If A1, A2, or A3 outputs appear malformed or internally inconsistent, stop and report. Do not paper over upstream issues in the engine.
- If the ranked table has suspiciously extreme P&L on a single family (e.g., 50%+ net edge), that is almost certainly a bug or a resolution-equivalence miss, not a real finding. Investigate before reporting.
- If the entry model or hold model has to be changed mid-build to avoid obvious unrealism, document the change and its justification in the interpretation document.

## What not to do

- Do not expand the ranked table with speculative columns (e.g., "projected P&L at $1M capital"). The owner's capital range is $5k–$25k. Extrapolations beyond that are noise.
- Do not claim a decision zone (GREEN/YELLOW/RED) without walking through the rubric's criteria row by row in the interpretation document.
- Do not ship a "demo" run on a subset of data and call it done. Full currently-linked sports family universe or it's not ready.
