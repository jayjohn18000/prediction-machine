# Backtest Interpretation — `<RUN_DATE>` (`<GIT_SHA>`)

_This is the skeleton. Copy to `a5-backtest-interpretation-YYYY-MM-DD.md` after a backtest run, fill the placeholders, and check it in alongside the run's `a5-backtest-templates-latest.csv` snapshot. Read `docs/pivot/success-rubric.md` first; this document is the rubric applied._

---

## Run inputs (copy from `a5-backtest-meta.json`)

| field | value |
|---|---|
| `created_at` | `<TBD>` |
| `git_sha` | `<TBD>` |
| `engine_version` | `<TBD>` |
| `cost_model_version` | `<TBD>` |
| `template_definition_version` | `<TBD>` |
| `entry_threshold_abs` | `<TBD>` USD per $100 |
| `interval_ms` | `<TBD>` |
| `premium_per_trade_usd` | `<TBD>` |
| `void_refund_model` | `<TBD>` |
| `a3_csv_path` | `<TBD>` |
| `a3_csv_sha256` | `<TBD>` |
| `settled_family_count` | `<TBD>` |
| `total_family_count` | `<TBD>` |

## Coverage at a glance

| sport | active families | settled families | trades_simulated (post-A3 + entry filter) |
|---|---|---|---|
| mlb | `<N>` | `<N>` | `<N>` |
| nhl | `<N>` | `<N>` | `<N>` |
| soccer | `<N>` | `<N>` | `<N>` |
| **total** | `<N>` | `<N>` | `<N>` |

Drop-off accounting (settled → trades_simulated):
- `<N>` skipped — `no_entry_found` (spread never crossed threshold)
- `<N>` skipped — `outcomes_missing` (A1 row absent for ≥1 leg)
- `<N>` skipped — `degenerate_prices` (≤0 or ≥1 at entry)
- `<N>` skipped — `a3_non_equivalent` (filtered upstream of engine)

## Per-template scoreboard

Paste the contents of `a5-backtest-templates-latest.csv` here, sorted by `total_pnl_history` desc. Three rows expected v1 (mlb / nhl / soccer kalshi-polymarket).

| template_id | trades | win_rate | mean_net_edge_per_100 | total_pnl | median_hold_days | disagreement_rate | void_rate |
|---|---|---|---|---|---|---|---|
| `sports.mlb.kalshi-polymarket` | | | | | | | |
| `sports.nhl.kalshi-polymarket` | | | | | | | |
| `sports.soccer.kalshi-polymarket` | | | | | | | |

## Rubric reading — GREEN / YELLOW / RED

### GREEN gate evaluation

A template clears the strict-threshold path if **all** of:
- `mean_net_edge_per_100 ≥ $1.00`
- `trades_simulated ≥ 20`
- `win_rate ≥ 0.55`
- `median_hold_days ≤ 30`
- `disagreement_rate ≤ 0.05`

| template | edge≥$1 | n≥20 | win≥0.55 | hold≤30 | disagree≤0.05 | clears? |
|---|---|---|---|---|---|---|
| mlb | | | | | | |
| nhl | | | | | | |
| soccer | | | | | | |

A template clears the high-edge path if **all** of:
- `mean_net_edge_per_100 ≥ $2.00`
- `trades_simulated ≥ 10`
- `win_rate ≥ 0.60`
- `median_hold_days ≤ 30`
- `disagreement_rate ≤ 0.05`

| template | edge≥$2 | n≥10 | win≥0.60 | hold≤30 | disagree≤0.05 | clears? |
|---|---|---|---|---|---|---|
| mlb | | | | | | |
| nhl | | | | | | |
| soccer | | | | | | |

Capacity-scaled monthly P&L (qualifying templates only): `<TBD — describe scaling assumption: deployment frequency × $5k–$25k capital>`. Result: `$<N>/month projected`.

### Decision

`<GREEN | YELLOW | RED>` because `<one-sentence justification tied to the table above>`.

### Per-template floor caveat (if invoked)

The rubric explicitly allows revisiting `trades_simulated` floors per template when a sport has limited per-season fixtures. If invoking this carve-out, name the template, state the alternative floor used, and cite the sample-size argument. Otherwise leave this section blank.

`<text or blank>`

## Forensic flags from the fixture CSV

Read `a5-backtest-fixtures-latest.csv` and surface anything notable. Examples worth a paragraph each:

- **Outlier P&L fixtures.** Any single fixture with `net_dollars` outside [−$50, +$50] gets named here with `family_id`, `template_id`, both `cheap_state` / `exp_state`, and one-line cause. Action: investigate the family and check A3 classification — do not reweight the rubric reading.
- **Disagreement clusters.** If a template's `disagreement_rate > 0.05`, list the offending fixture rows so A3 can re-audit. The template is excluded from GREEN regardless of edge until the disagreements clear.
- **Void clusters.** If `void_rate > 0.10` for a template, name the constituent fixtures and the resolution_source pattern they share — likely a venue-policy issue worth tracking.
- **Skip clusters.** If a sport's `no_entry_found` rate is high (e.g., >30% of settled families), the threshold may be miscalibrated for that sport's typical spread. Flag for re-tune of `entry_threshold_abs` per the rubric's parameter knobs.

## Action map

Fill in based on decision zone:

### If GREEN
- Capital sizing: `<lowest end of pilot range, e.g., $5k>`
- Live universe: `<list qualifying template_ids>`
- Kill switches enabled: stale-data, venue-instability, per-template realized-vs-backtest divergence >50% in first two weeks
- Phase H entry checklist owner: `<name>`
- Target start date: `<YYYY-MM-DD>`

### If YELLOW
- Qualifying templates: `<list>`
- Linker prioritization changes: `<which fixture attributes to chase, ordered>`
- Target ingestion expansion: `<which sports / event types within sports>`
- Rerun cadence: `<weekly / biweekly>` until backtested P&L clears the $5k/month bar
- Explicit non-goal: do not onboard new providers or new categories during YELLOW

### If RED
Pick the dominant interpretation and document the next step:
- **A. Cost model too pessimistic.** Evidence: `<TBD>`. Re-tune fee/slippage per `success-rubric.md` parameters; re-run.
- **B. Equivalent-pair universe too small.** Evidence: `<TBD>`. Implies cross-venue arb thesis does not clear at this coverage in 2026.
- **C. Wrong category.** Evidence: `<TBD>`. Run the full pivot on politics before concluding.
- **D. Thesis is wrong.** Evidence: `<TBD>`. Reframe project: sell intelligence layer as a data product, not as execution strategy.

## Parameter re-tunes proposed (if any)

If this run argues for a parameter change, document it here per the rubric's "Parameters that may be re-tuned" section. Each entry: parameter name, old value, proposed new value, rationale tied to a row in this run's CSVs.

`<table or blank>`

## Open questions for the next run

`<bullet list or blank>`
