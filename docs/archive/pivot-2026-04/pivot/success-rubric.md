# Success Rubric — How to Interpret the Backtest Output

_Read `north-star.md` first. This file answers: once the backtest lands, what does the output mean, and what decision follows?_

---

## What the backtest produces

The backtest writes three artifacts per run, kept separate so the scoreboard CSV is byte-identical run-over-run regardless of when it was generated:

**`a5-backtest-templates-latest.csv` — the scoreboard.** Per-template aggregates. This is what GREEN/YELLOW/RED is read from. Columns:

- `template_id` — stable slug, e.g. `sports.mlb.kalshi-polymarket`
- `template_label` — human-readable
- `category` — `sports` / `politics` / `crypto` / `economics`
- `trades_simulated` — count of fixture-level trades aggregated into this template (includes void trades; see `void_rate`)
- `win_rate` — fraction of constituent fixture trades with `net_dollars > 0`
- `mean_net_edge_per_100` — mean of fixture-level `net_dollars`; trades are fixed at $100 deployment so this reads directly
- `total_pnl_history` — sum of fixture `net_dollars`
- `median_hold_days` — across constituent fixtures
- `disagreement_rate` — fraction of constituent fixtures where both legs won (windfall) or both lost (wipe). Should be ≈ 0 for equivalent templates; non-zero means A3 missed an equivalence failure
- `void_rate` — fraction of constituent fixtures where any leg resolved void
- `resolution_equivalence` — homogeneous across constituent fixtures (`equivalent`); flagged `mixed` otherwise (should not occur if A3 filter is applied at engine input)

**`a5-backtest-fixtures-latest.csv` — the audit trail.** Per-fixture detail; read when a template's number looks suspicious or when forensics are needed. Columns include `family_id`, `template_id`, `direction` (`k_cheap` | `p_cheap`), `spread_at_entry`, `cheap_state` and `exp_state` (`won` | `lost` | `void`), `gross_dollars`, `net_dollars`, per-leg costs, `hold_days`, `resolution_disagreement`, `entry_threshold_used`, `snapshot_interval`. Rows where no entry was detected are still logged with `skip` populated (`no_entry_found`, `outcomes_missing`, `degenerate_prices`) and excluded from `trades_simulated`.

**`a5-backtest-meta.json` — run metadata sidecar.** Holds the things that would otherwise break determinism if embedded in CSV bodies: `created_at`, `git_sha`, engine + cost model + template-definition versions, `entry_threshold_abs`, `interval_ms`, `premium_per_trade_usd`, `void_refund_model: 'full_refund_v1'`, `a3_csv_path`, `a3_csv_sha256`, `settled_family_count`, `total_family_count`, output CSV SHA-256s. Any timestamp or environment value lives here, never in the CSVs.

Templates are defined by the engine's `templateOf(family)` function (currently sport-specific; politics, crypto, and economics get their own dispatches as those categories enter scope). Re-tuning template granularity is a structural change to that function, not a threshold knob.

## The three decision zones

### GREEN — proceed to guarded live pilot (Phase H)

At least one of the following is true:

- **10+ templates** with `mean_net_edge_per_100 ≥ $1.00`, `trades_simulated ≥ 20`, `win_rate ≥ 0.55`, `median_hold_days ≤ 30`, **and `disagreement_rate ≤ 0.05`**.
- **3+ templates** with `mean_net_edge_per_100 ≥ $2.00`, `trades_simulated ≥ 10`, `win_rate ≥ 0.60`, `median_hold_days ≤ 30`, **and `disagreement_rate ≤ 0.05`**.
- Total backtested P&L across all qualifying templates, scaled to realistic deployment frequency at $5k–$25k capital, projects to **≥ $5k/month**.

**Disagreement-rate gate is not optional.** A template with `disagreement_rate > 0.05` is excluded from GREEN regardless of edge — high disagreement means A3 marked the family equivalent but the venues actually resolved differently, and the apparent edge is being inflated by windfall payouts on misclassified trades. Templates failing this gate must drop back to an A3 re-audit before counting toward GREEN.

**Action if GREEN:** proceed to Phase H. Live universe = the qualifying `template_id`s (linker routes new fixtures to templates; pilot trades any fixture rolling up to an approved template). Capital sizing per the lowest end of the pilot range initially. Hard kill switches on stale data, venue instability, and any *template* whose realized edge diverges >50% from backtested edge within the first two weeks.

### YELLOW — edge exists but coverage is too thin; expand *inside sports*

All of the following:

- **1–9 templates** meet the GREEN per-template thresholds (including disagreement gate).
- Projected monthly P&L at $5k–$25k capital is **below $5k/month**.

**Action if YELLOW:** the qualifying templates *are* the expansion target. Linker prioritizes new fixtures whose attributes roll up into those `template_id`s. Re-run ingestion + linking focused on within-sports expansion that grows the constituent fixture count of the qualifying templates. Re-run backtest. This is the only condition under which coverage expansion is the right lever; even then it's expansion *into named templates*, not breadth expansion. Do not onboard new providers or new categories.

### RED — edge is not demonstrable on current coverage

Any of:

- **Zero templates** meet the GREEN per-template thresholds.
- Templates that nominally qualify do so via small-sample noise (`trades_simulated` near the floor AND `disagreement_rate` near the 5% ceiling — i.e., barely qualifying with the most permissive interpretation).
- Mean `mean_net_edge_per_100` across all templates is negative after fees + slippage + lockup.

**Action if RED:** stop building. This is the hard conversation the pivot was designed to force. Possible interpretations and their implications:

- **Interpretation A:** the cost model is too pessimistic. Re-examine A2's fee/slippage assumptions, tighten, re-run. Only valid if the assumptions are provably too conservative against real exchange data.
- **Interpretation B:** resolution equivalence is stricter than assumed, and the remaining equivalent-pair universe is too small to produce persistent edge. Implies the cross-venue-arb thesis for Kalshi↔Polymarket sports does not clear for a solo operator in 2026.
- **Interpretation C:** sports is the wrong category and politics (second-choice family set) may clear. Re-run the full pivot on politics before concluding.
- **Interpretation D:** the thesis is wrong. The pros have already eaten persistent cross-venue edge, and the business isn't there for a solo operator at $5k–$25k capital. Reframe the project — e.g., sell the intelligence layer as a data product, not as an execution strategy.

RED does not mean failure. RED is the answer the pivot was designed to deliver if the edge isn't real. Getting there in weeks, with a ledger-grade argument, is massively better than spending another year on coverage expansion.

## Parameters that may be re-tuned after first backtest run

These are working numbers in `north-star.md` and the engine's defaults. Any re-tune must be documented here with the rationale.

- **Edge threshold ($1.00 / $100 default).** If the cost model turns out to overestimate slippage by a demonstrable margin, the threshold can drop to $0.75 or $0.50. If realized slippage in the eventual live pilot exceeds model by >20%, the threshold rises to $1.50 or $2.00.
- **Trade-count floor (20 for GREEN).** Now applies at the template level. A template with limited per-season fixtures (e.g., niche sports leagues) may still be robust at lower count given large per-trade edge. Revisit per-template, not per-sport.
- **Win-rate floor (0.55 for GREEN).** Same threshold; with the arb construction, win-rate becomes "fraction of trades with positive net P&L" — slightly different semantics from a directional bet's win-rate but the threshold transfers.
- **Hold-duration ceiling (30 days).** Per-template median; tail fixtures inside a qualifying template may exceed without disqualifying the template, but a *median* > 30 means capital lockup dominates edge.
- **Disagreement-rate ceiling (5%).** New parameter. Working assumption: any template with >5% of constituent fixtures showing both-legs-won or both-legs-lost has an A3 equivalence problem inflating its apparent edge. Tighten to 1–2% post-pilot if A3 audits get more reliable; relax cautiously if cost model proves disagreements are real but edge survives them.
- **Void-refund model.** v1 assumes full refund of premium + fees + slippage + lockup on void legs. If live exchange behavior diverges (Polymarket fees-on-fill not refunded; Kalshi cancellation policy changes), update cost model and re-run.
- **Template granularity.** Structural, not numeric. Tighter `templateOf()` (more attributes) = more rows, smaller per-template counts. Looser = fewer rows, larger counts but coarser grouping. Today's sports default: `(sport, provider_pair)`; v1 explicitly defers `(event_type, resolution_source_pattern)` until needed. Changes here invalidate prior backtest comparisons; document any change with a `template_definition_version` bump in the meta JSON.

## What the rubric deliberately does NOT measure

- Families linked. Not on the scoreboard.
- Proposals accepted. Not on the scoreboard.
- Ingestion freshness. Not on the scoreboard unless it degrades backtest inputs.
- Classifier accuracy. Not on the scoreboard.
- Coverage percentage vs. OddPool or similar. Not on the scoreboard.
- Per-fixture identity. The audit CSV exposes individual fixture P&L for forensics, but the scoreboard reads templates only. A single fixture printing extreme P&L (windfall or wipe) does not move the gate; the template aggregate does. If a per-fixture row looks suspicious, the action is "investigate the family + check A3 classification," not "promote the fixture into the rubric reading."

If a piece of work moves one of these numbers but does not move the ranked family P&L table, it is out of scope for the pivot.
