# Success Rubric — How to Interpret the Backtest Output

_Read `north-star.md` first. This file answers: once the backtest lands, what does the output mean, and what decision follows?_

---

## What the backtest produces

A ranked per-family table with (at minimum) these columns:

- `family_id`
- `sport` / `category`
- `trades_simulated` — count of entry events in history
- `win_rate` — fraction that resolved profitably
- `mean_net_edge_per_100` — average realized net dollars per $100 notional, after fees + slippage
- `total_pnl_history` — sum of realized P&L across all simulated trades
- `median_hold_days` — capital-lockup duration
- `resolution_equivalence` — `equivalent` / `ambiguous` (non-equivalent families are excluded from the table entirely)

Everything below is how to read that table to make a decision.

## The three decision zones

### GREEN — proceed to guarded live pilot (Phase H)

At least one of the following is true:

- **10+ families** with `mean_net_edge_per_100 ≥ $1.00`, `trades_simulated ≥ 20`, `win_rate ≥ 0.55`, and `median_hold_days ≤ 30`.
- **3+ families** with `mean_net_edge_per_100 ≥ $2.00`, `trades_simulated ≥ 10`, `win_rate ≥ 0.60`, and `median_hold_days ≤ 30`.
- Total backtested P&L across all qualifying families, scaled to realistic deployment frequency at $5k–$25k capital, projects to **≥ $5k/month**.

**Action if GREEN:** proceed to Phase H (guarded live pilot). Restrict live universe to the qualifying families only. Capital sizing per the lowest end of the pilot range initially. Hard kill switches on stale data, venue instability, and any family whose realized edge diverges >50% from backtested edge within the first two weeks.

### YELLOW — edge exists but coverage is too thin; expand *inside sports*

All of the following:

- **1–9 families** meet the GREEN per-family thresholds.
- Projected monthly P&L at $5k–$25k capital is **below $5k/month**.
- The qualifying families share identifiable characteristics (same sport, same event type, same resolution source pattern, similar hold duration).

**Action if YELLOW:** do *not* onboard new providers or new categories. Instead, use the qualifying families as a template. Re-run ingestion + linking focused on expanding *within sports*, specifically targeting markets that resemble the winners on the shared characteristics. Re-run backtest. This is the only condition under which coverage expansion is the right lever, and even then it's narrow expansion, not breadth expansion.

### RED — edge is not demonstrable on current coverage

Any of:

- **Zero families** meet the GREEN per-family thresholds.
- Qualifying families exist but their characteristics are not repeatable (one-off anomalies, e.g., a single correctly-called upset).
- Mean `mean_net_edge_per_100` across all families is negative after fees + slippage.

**Action if RED:** stop building. This is the hard conversation the pivot was designed to force. Possible interpretations and their implications:

- **Interpretation A:** the cost model is too pessimistic. Re-examine A2's fee/slippage assumptions, tighten, re-run. Only valid if the assumptions are provably too conservative against real exchange data.
- **Interpretation B:** resolution equivalence is stricter than assumed, and the remaining equivalent-pair universe is too small to produce persistent edge. Implies the cross-venue-arb thesis for Kalshi↔Polymarket sports does not clear for a solo operator in 2026.
- **Interpretation C:** sports is the wrong category and politics (second-choice family set) may clear. Re-run the full pivot on politics before concluding.
- **Interpretation D:** the thesis is wrong. The pros have already eaten persistent cross-venue edge, and the business isn't there for a solo operator at $5k–$25k capital. Reframe the project — e.g., sell the intelligence layer as a data product, not as an execution strategy.

RED does not mean failure. RED is the answer the pivot was designed to deliver if the edge isn't real. Getting there in weeks, with a ledger-grade argument, is massively better than spending another year on coverage expansion.

## Parameters that may be re-tuned after first backtest run

These are working numbers in `north-star.md`. The backtest may justify revisiting them. Any re-tune must be documented in this file with the rationale.

- **Edge threshold ($1.00 / $100 default).** If the cost model turns out to overestimate slippage by a demonstrable margin, the threshold can drop to $0.75 or $0.50. If realized slippage in the eventual live pilot exceeds model by >20%, the threshold rises to $1.50 or $2.00.
- **Trade-count floor (20 for GREEN).** If the sport has a limited number of games per season, a lower trade count may still be robust given per-trade edge size. Revisit per-sport.
- **Win-rate floor (0.55 for GREEN).** A lower win-rate with much larger per-win edge is still tradeable. A rubric that combines win-rate and edge size into expected-value-per-trade is acceptable as a follow-on refinement.
- **Hold-duration ceiling (30 days).** Capital-lockup is a real cost. If a family has 60-day holds but clears 4% net edge, it may still be worth trading at reduced allocation. Decide per-family.

## What the rubric deliberately does NOT measure

- Families linked. Not on the scoreboard.
- Proposals accepted. Not on the scoreboard.
- Ingestion freshness. Not on the scoreboard unless it degrades backtest inputs.
- Classifier accuracy. Not on the scoreboard.
- Coverage percentage vs. OddPool or similar. Not on the scoreboard.

If a piece of work moves one of these numbers but does not move the ranked family P&L table, it is out of scope for the pivot.
