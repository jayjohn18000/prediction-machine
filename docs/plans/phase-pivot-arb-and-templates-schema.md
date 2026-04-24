# Phase Pivot: Arb Construction + Per-Template Scoreboard — Schema & Architecture

> Companion to `phase-pivot-arb-and-templates-plan.md`. Sub-agents A and B both read this before writing code.

## Files in this phase

| Path | New / Refactor | Owner | Purpose |
|---|---|---|---|
| `lib/backtest/types.mjs` | NEW | A (consumed by B) | JSDoc typedefs for `FixtureRow` and `Template`. No runtime code. |
| `lib/backtest/leg-resolver.mjs` | NEW | A | Tri-state `resolveLeg()` → `'won' \| 'lost' \| 'void'`. |
| `lib/backtest/arb-trade.mjs` | NEW | A | `arbTrade()` — cross-venue arb construction returning a `FixtureRow`. |
| `lib/backtest/run-engine.mjs` | REFACTOR | A | Calls `arbTrade()`; emits `FixtureRow[]` (one per family, including skip rows). |
| `lib/backtest/template.mjs` | NEW | B | `templateOf()` + `SPORT_ALIASES` + `normalizeSport()`. |
| `lib/backtest/aggregate.mjs` | NEW | B | `aggregateByTemplate()` — produces scoreboard rows. |
| `scripts/backtest/run-backtest.mjs` | REFACTOR | B | Writes three artifacts (templates CSV, fixtures CSV, meta JSON). |
| `lib/backtest/leg-payout.mjs` | KEEP | — | Used by `leg-resolver.mjs`. No changes. |
| `lib/backtest/equivalence-csv.mjs` | KEEP | — | A3 CSV loader. No changes. |
| `test/backtest/leg-resolver.test.mjs` | NEW | A | Unit tests for resolver. |
| `test/backtest/arb-trade.test.mjs` | NEW | A | Unit tests for arb construction. |
| `test/backtest/template.test.mjs` | NEW | B | Unit tests for `templateOf` + alias map. |
| `test/backtest/aggregate.test.mjs` | NEW | B | Unit tests for aggregator. |
| `test/backtest/determinism.test.mjs` | NEW | B | Byte-equality tests for CSV serialization. |

## Fixture row shape (`FixtureRow` typedef)

```js
/**
 * @typedef {object} FixtureRow
 * @property {string}      family_id                      - Stable bilateral family id (text).
 * @property {string}      template_id                    - From templateOf(); 'sports.{sport}.kalshi-polymarket' or 'sports.unknown.kalshi-polymarket' or 'audit-only'.
 * @property {string}      template_label                 - Human-readable.
 * @property {string}      category                       - 'sports' or pass-through (may be polluted by Polymarket event slug).
 * @property {boolean}     template_include_in_scoreboard - True only for known sports templates.
 * @property {string|null} sport                          - Canonical sport id ('mlb'|'nhl'|'soccer') or null for unknown/non-sports.
 * @property {string}      resolution_equivalence         - 'equivalent' (filtered upstream by A3).
 *
 * --- skip semantics ---
 * @property {string|null} skip                           - null for traded rows; one of: 'no_entry_found' | 'outcomes_missing' | 'degenerate_prices' | 'not_eligible_no_template'.
 *
 * --- trade detail (null on skip rows) ---
 * @property {'k_cheap'|'p_cheap'|null} direction         - Which venue was cheap at entry.
 * @property {number|null}              spread_at_entry   - |kYes - pYes| at entry, in 0–1 units.
 * @property {'won'|'lost'|'void'|null} cheap_state       - Cheap leg's resolution state.
 * @property {'won'|'lost'|'void'|null} exp_state         - Expensive leg's resolution state.
 * @property {number|null}              gross_dollars     - Gross P&L before costs (USD, full precision).
 * @property {number|null}              net_dollars       - Net P&L after costs and void refunds (USD, full precision).
 * @property {number|null}              hold_days         - Calendar days from entry to last leg resolution; integer (Math.ceil).
 * @property {object|null}              cheap_costs_breakdown - Output of estimateCost() for the cheap leg.
 * @property {object|null}              exp_costs_breakdown   - Output of estimateCost() for the expensive leg.
 *
 * --- run config stamp (always populated, even on skip rows) ---
 * @property {number}      entry_threshold_used    - The threshold this run used (e.g. 0.01 for $1/$100).
 * @property {number}      snapshot_interval_ms    - Hourly = 3600000.
 * @property {string}      void_refund_model       - 'full_refund_v1'.
 */
```

```js
/**
 * @typedef {object} Template
 * @property {string}  template_id
 * @property {string}  template_label
 * @property {string}  category
 * @property {boolean} include_in_scoreboard
 */
```

## CSV column orders

### Fixtures CSV columns (sort: `template_id ASC, family_id ASC`)

```
family_id, template_id, template_label, category, sport, resolution_equivalence,
skip,
direction, spread_at_entry, cheap_state, exp_state,
gross_dollars, net_dollars, hold_days,
entry_threshold_used, snapshot_interval_ms, void_refund_model
```

`cheap_costs_breakdown` and `exp_costs_breakdown` are NOT serialized to the fixture CSV (they are objects; preserve in the engine's in-memory return for tests, but flatten the relevant fee/slippage/lockup totals into separate columns IF needed for forensics in v2). For v1, keep the CSV minimal.

### Templates CSV columns (sort: `total_pnl_history DESC, template_id ASC`)

```
template_id, template_label, category,
trades_simulated, win_rate, mean_net_edge_per_100,
total_pnl_history, median_hold_days,
disagreement_rate, void_rate,
resolution_equivalence
```

Per `success-rubric.md` § "What the backtest produces".

## Numeric formatting

- Dollar amounts (`mean_net_edge_per_100`, `total_pnl_history`, `gross_dollars`, `net_dollars`): `round2` — round to 2 decimal places using a stable formatter. Implementation: `Math.round(x * 100) / 100`. Avoid `Number.prototype.toFixed` for body cells (locale risk); use a deterministic formatter.
- Rates (`win_rate`, `disagreement_rate`, `void_rate`): `round4` — 4 decimal places. `Math.round(x * 10000) / 10000`.
- `median_hold_days`: integer; tiebreak via `Math.floor((n - 1) / 2)` index of the sorted array.
- `spread_at_entry`: full precision (no rounding) — kept as raw double for forensic inspection.

## Meta JSON keys

```json
{
  "created_at": "2026-04-24T18:00:00.000Z",
  "git_sha": "abc123...",
  "engine_version": "arb-v1",
  "cost_model_version": "<read from lib/execution/costs.mjs export or hardcode 'v1'>",
  "template_definition_version": "sports-v1",
  "entry_threshold_abs": 0.01,
  "interval_ms": 3600000,
  "premium_per_trade_usd": 100,
  "void_refund_model": "full_refund_v1",
  "a3_csv_path": "docs/pivot/artifacts/a3-resolution-equivalence-...csv",
  "a3_csv_sha256": "...",
  "settled_family_count": 24,
  "total_family_count": 88,
  "templates_csv_sha256": "...",
  "fixtures_csv_sha256": "..."
}
```

All time-varying values live ONLY in this file — never in CSV bodies. SHA-256s of the two CSVs are computed AFTER they're written and added to the meta JSON before it's flushed.

## Arb construction math

Given `kYes` and `pYes` in `(0, 1)` at entry, $100 deployment per fixture, and threshold gate `|kYes − pYes| ≥ entry_threshold_abs`:

```
let cheapVenue, cheapPrice, expVenue, expPriceYes;
if (kYes <= pYes) {
  cheapVenue = 'kalshi';     cheapPrice = kYes;
  expVenue   = 'polymarket'; expPriceYes = pYes;
  direction = 'k_cheap';
} else {
  cheapVenue = 'polymarket'; cheapPrice = pYes;
  expVenue   = 'kalshi';     expPriceYes = kYes;
  direction = 'p_cheap';
}

const expPriceNo = 1 - expPriceYes;
const N = 100 / (cheapPrice + expPriceNo);  // contracts per leg
const cheapPremium = N * cheapPrice;
const expPremium   = N * expPriceNo;
// invariant: cheapPremium + expPremium ≈ 100 within $0.01

// Resolution
const cheapState = resolveLeg({market: cheapMarket, side: 'yes', winningOutcome: cheapOutcome});
const expState   = resolveLeg({market: expMarket,   side: 'no',  winningOutcome: expOutcome});

// Gross (per leg, before refund logic)
const cheapGross = cheapState === 'won' ? N - cheapPremium : -cheapPremium;
const expGross   = expState   === 'won' ? N - expPremium   : -expPremium;
//   In a clean arb: exactly one of {cheapState='won', expState='won'} is true; the other is 'lost'.
//   When both 'won' → windfall (disagreement); both 'lost' → wipe (disagreement).

// Costs
const cheapCost = estimateCost({venue: cheapVenue, side: 'yes', price: cheapPrice, size: cheapPremium, hold_days, polymarket_category: 'sports'});
const expCost   = estimateCost({venue: expVenue,   side: 'no',  price: expPriceYes, size: expPremium,   hold_days, polymarket_category: 'sports'});

// Void refund (v1: full_refund_v1)
let cheapNet = cheapGross - cheapCost.total_cost_dollars;
let expNet   = expGross   - expCost.total_cost_dollars;
if (cheapState === 'void') cheapNet = 0;  // refund premium + costs
if (expState   === 'void') expNet   = 0;  // refund premium + costs

const gross_dollars = cheapGross + expGross;          // pre-refund, pre-cost
const net_dollars   = cheapNet + expNet;              // post-refund, post-cost
```

Note: `estimateCost`'s `price` argument is always YES probability, regardless of side. The function clamps internally and applies `1−p` for NO legs in fee math.

## Sport alias map (v1)

```js
export const SPORT_ALIASES = {
  mlb:    ['mlb', 'baseball', 'majorleaguebaseball'],
  nhl:    ['nhl', 'hockey', 'nationalhockeyleague'],
  soccer: ['soccer', 'football', 'fifa', 'epl', 'mls', 'uefa', 'laliga'],
};
```

`normalizeSport(raw)` strips `raw` to lowercase alphanumeric, looks up in the flattened alias index, returns canonical id or `null`. Identity-only for v1 against current data (mlb/nhl/soccer all match themselves); the indirection earns its keep when a future provider arrives with divergent labels.

## Architectural Decisions

### Why three artifacts instead of one CSV with a meta header

The rubric reads from per-template aggregates with thresholds like `trades_simulated ≥ 20`. The audit trail needs per-fixture detail for forensics. Cramming both into a single CSV requires either header banners (which break determinism and make machine parsing harder) or per-row level columns (which bloat the audit CSV with redundant aggregation).

Splitting into three artifacts keeps each one purpose-built:

- `a5-backtest-templates-latest.csv` — what the rubric reads. Small, readable, sortable.
- `a5-backtest-fixtures-latest.csv` — forensics. Per-fixture detail including skip rows.
- `a5-backtest-meta.json` — anything that varies run-to-run on the same inputs. Lets the CSVs be byte-identical so PR diffs are meaningful.

### Why void refund v1 = full refund

Polymarket and Kalshi both refund premium on void/cancel in their docs. v1 also assumes the venue refunds the fees and slippage paid on entry, plus the lockup cost. This is a working approximation — when the live pilot starts producing real void cases, the model gets revised and stamped `full_refund_v2` (or whatever) per the rubric's parameter knobs. v1 is conservative-leaning: real venues may not fully refund slippage, but they also may not, and the rubric explicitly allows this assumption to be revisited.

### Why entry-search runs to ingestion window end (not min of leg `resolved_at`)

The current implementation truncates entry-search at `MIN(kalshi.resolved_at, poly.resolved_at)`. This loses real entry opportunities late in the window when one leg resolved earlier than the other. The corrected behavior searches across the full ingestion window and uses `MAX(...)` of the resolved_at timestamps for `holdDays`. Hold-to-resolution still applies — if entry happens after one leg has already resolved, that's a real edge case worth flagging in the audit CSV (this phase emits the row as-is; the interpretation doc can call it out if material).

### Why sports-only on the scoreboard

Per `CLAUDE.md` pivot guardrails: no E2/E3 work. The 88 active bilateral sports families are the only A3-audited universe with any settled history (24 settled). Politics has 59 active bilateral families but ZERO settled (2028 nominee markets won't resolve until 2026–2028). Crypto and economics have 0 active bilateral families. Including them on the scoreboard would produce zero data with high architectural cost (multi-outcome arb model + A3-for-politics audit). They pass through the engine as audit-only fixture rows so the interpretation doc can speak to RED-case C ("politics may clear") with concrete counts.

### Why `templateOf` is a function, not a static map

Templates are derived from family attributes (sport, provider pair). When a new provider arrives, the template id format changes (`sports.mlb.kalshi-polymarket-X`). When a sport adds attribute granularity (e.g., `(sport, event_type)`), the template space partitions further. A function lets the granularity decision live in code, versioned by `template_definition_version` in the meta JSON. A static map would require schema migrations for each granularity tweak.

## Dependencies

No new npm packages. All implementation uses Node built-ins (`crypto` for SHA-256, `child_process` for `git rev-parse HEAD`, `fs` for I/O) plus existing project deps (`pg`).

Environment variables (already wired in `scripts/backtest/run-backtest.mjs`):

- `DATABASE_URL` — required.
- `PMCI_BACKTEST_USE_STUB` — dev only; loud stderr banner; not a real scoreboard run.
- `PMCI_ENTRY_THRESHOLD_ABS` — override default 0.01 (i.e. $1.00 / $100).

## Test Runner

Test runner is `node --test`, invoked via `npm test` (script: `node --test test/**/*.test.mjs`). Tests live under `test/backtest/`. Mirror the import/assertion style of `test/backtest/leg-payout.test.mjs`. No new test framework dependencies.
