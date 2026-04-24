# Phase Pivot: Arb Construction + Per-Template Scoreboard — Execution Plan

## Overview

Refactor the A5 backtest engine so its output satisfies the rubric in `docs/pivot/success-rubric.md`. Two structural fixes:

1. **Replace the directional long-YES-on-both-legs trade** (currently in `lib/backtest/run-engine.mjs`) with a real cross-venue arb: long YES on the cheap venue, long NO on the expensive venue, $100 deployment per fixture.
2. **Replace the single per-fixture CSV** with three artifacts: per-template scoreboard CSV (what the rubric reads), per-fixture audit CSV (forensic trail including skip rows), and a meta JSON sidecar (run timestamps, hashes, versions — anything that would otherwise break determinism).

This unblocks the first real backtest run and the first interpretation-doc fill-in. Skeleton interpretation doc already lives at `docs/pivot/artifacts/a5-backtest-interpretation-template.md`.

Sports-only on the scoreboard. Politics/crypto/economics families pass through the engine as audit-only fixture rows but do not roll up to a scoreboard template. This is intentional and per pivot guardrails — see `CLAUDE.md`.

## Prerequisites

Already in place — verify before starting:

- A1 outcomes ingested into `pmci.market_outcomes` (24 settled bilateral sports families as of 2026-04-24).
- A2 cost model in `lib/execution/costs.mjs` exposing `estimateCost({venue, side, price, size, hold_days, polymarket_category})`.
- A3 equivalence audit CSV — default path resolved by `lib/backtest/equivalence-csv.mjs`. 88 equivalent sports families.
- Snapshot table `pmci.provider_market_snapshots` populated for the 88 active bilateral sports families.
- Existing files to refactor: `lib/backtest/run-engine.mjs`, `scripts/backtest/run-backtest.mjs`.
- Existing helpers to keep as-is: `lib/backtest/leg-payout.mjs`, `lib/backtest/equivalence-csv.mjs`.

Required reads before writing code:

- `docs/pivot/success-rubric.md` — the rubric the output must satisfy. Column lists for `a5-backtest-templates-latest.csv` and `a5-backtest-fixtures-latest.csv`, plus required keys for `a5-backtest-meta.json`, are normative.
- `docs/pivot/agents/a5-backtest-engine.md` — A5 brief.
- `docs/pivot/artifacts/a5-backtest-interpretation-template.md` — what the next chat will fill in from this phase's output. The placeholders define the meta-JSON keys that must exist.
- `docs/plans/phase-pivot-arb-and-templates-schema.md` — data models, contracts, type definitions for this phase. **Sub-agent A and Sub-agent B must both read this before writing code.**

Sub-agent split (designed for parallel Cursor dispatch via `cursor-orchestrator`):

- **Sub-agent A** — Trade construction. Owns Steps 1–4 + Step 9 (its own tests).
- **Sub-agent B** — Templates and output. Owns Steps 5–8 + Step 10 (its own tests).
- Shared contract: `lib/backtest/types.mjs` (Step 1). Sub-agent A writes it; Sub-agent B imports it. Both must agree on the fixture-row shape before parallel work begins.
- Step 11 (verification) is sequential after both merge.

## Execution Steps

### Step 1: Lock the fixture-row contract (`lib/backtest/types.mjs`)

**Owner:** Sub-agent A (Sub-agent B must wait for this file before starting Step 5).

Create `lib/backtest/types.mjs` containing JSDoc typedefs only — no executable code. Two typedefs are required:

- `FixtureRow` — every column listed in `success-rubric.md` for the fixture CSV, plus the template-stamp fields (`template_id`, `template_label`, `category`, `template_include_in_scoreboard`), the `skip` reason field (`null` for traded rows), and per-leg fields (`cheap_state`, `exp_state`, `direction`, `spread_at_entry`, `gross_dollars`, `net_dollars`, `hold_days`, `entry_threshold_used`, `snapshot_interval_ms`, `void_refund_model`, `cheap_costs_breakdown`, `exp_costs_breakdown`).
- `Template` — `{template_id, template_label, category, include_in_scoreboard}` returned by `templateOf()`.

The full field list and types live in `docs/plans/phase-pivot-arb-and-templates-schema.md` § "Fixture row shape" — copy from there verbatim.

**Files affected:** `lib/backtest/types.mjs` (new).
**Expected output:** File exists, lints clean, no runtime side effects, both sub-agents reference it via `/** @typedef {import('./types.mjs').FixtureRow} FixtureRow */`.

### Step 2: Implement tri-state leg resolver (`lib/backtest/leg-resolver.mjs`)

**Owner:** Sub-agent A.

Create `lib/backtest/leg-resolver.mjs` exporting `resolveLeg({market, side, winningOutcome}) → 'won' | 'lost' | 'void'`. The function:

- Returns `'void'` if `winningOutcome` is `null`, `''`, the literal string `'unknown'`, or the market metadata indicates void/cancelled (check the existing fields on `provider_markets` row passed in via `market`).
- For Kalshi, delegates the won/lost decision to `kalshiLongYesPays({winning_outcome})` from `leg-payout.mjs` when `side === 'yes'`; inverts when `side === 'no'`.
- For Polymarket, delegates to `polyLongYesPays(market, winningOutcome)` when `side === 'yes'`; inverts when `side === 'no'`.

**Files affected:** `lib/backtest/leg-resolver.mjs` (new).
**Expected output:** Pure function, no DB calls, fully unit-testable. Returns one of three string literals.

### Step 3: Implement arb trade construction (`lib/backtest/arb-trade.mjs`)

**Owner:** Sub-agent A.

Create `lib/backtest/arb-trade.mjs` exporting `arbTrade(params)`. Inputs (see schema doc for full shape): both legs' YES prices at entry, both legs' market rows, both legs' winning outcomes, `holdDays`, `entryThresholdAbs`, `snapshotIntervalMs`. Behavior:

1. Determine direction: `direction = kYesAtEntry <= pYesAtEntry ? 'k_cheap' : 'p_cheap'`.
2. Cheap leg trades YES at `min(kYes, pYes)`. Expensive leg trades NO at `1 - max(kYes, pYes)`.
3. Sizing: `N = 100 / (cheapPrice + expensivePrice_no)` where `expensivePrice_no = 1 - expensiveYes`. Each leg's premium = `N * its_price`. Premiums must sum to ≤ $100 within a $0.01 tolerance.
4. Resolve each leg with `resolveLeg()` (Step 2).
5. Compute gross: contracts × $1 payoff if `won`, $0 if `lost`. Void leg returns `'void'` and is handled per the refund model (Step 4 below).
6. Compute net: gross minus per-leg cost from `estimateCost(leg)` (cost detail per leg stored in the fixture row's `*_costs_breakdown`).
7. Apply void refund model v1 (`'full_refund_v1'`):
   - For each leg with state `'void'`, refund its full premium + fees + slippage + lockup.
   - Non-void leg pays/receives normally.
   - Stamp `void_refund_model: 'full_refund_v1'` on the returned fixture row.
8. Return a `FixtureRow`-shaped object (Step 1) with `skip: null`, both `cheap_state` and `exp_state` populated, `direction`, `spread_at_entry`, `gross_dollars`, `net_dollars`, both `*_costs_breakdown` blocks, `hold_days`, `entry_threshold_used`, `snapshot_interval_ms`.

Pure function — no DB, no clock reads. The caller passes `holdDays`. Numeric formatting (rounding) is the aggregator's job, not this function's; emit full-precision floats.

**Files affected:** `lib/backtest/arb-trade.mjs` (new).
**Expected output:** Function returns a `FixtureRow` for traded fixtures. Premiums sum ≤ $100. `direction`, both `*_state` fields, and `void_refund_model` are always set.

### Step 4: Refactor `lib/backtest/run-engine.mjs` to call `arbTrade`

**Owner:** Sub-agent A.

Replace the directional-bet body of `simulateOneFamily()`:

- Keep `loadBilateralFamilies` query as-is for now (it joins through `provider_markets` correctly; sport lives at `pm.sport`).
- After loading snapshots and outcomes, the entry-search loop stays largely the same BUT: change `tEnd` from `MIN(kalshi.resolved_at, poly.resolved_at)` to the ingestion window end (use `MAX(byK[byK.length-1].observed_at, byP[byP.length-1].observed_at)`). The leg `resolved_at` values are still used to compute `holdDays` after entry is found, but they no longer truncate entry-search.
- Replace the `nk = PREMIUM_PER_LEG / kPrice; np = PREMIUM_PER_LEG / pPrice; gross = ...` block with a call to `arbTrade({...})`.
- The function still returns one row per family, but now it returns a `FixtureRow`. Skip cases (`outcomes_missing`, `no_entry_found`, `degenerate_prices`) populate `skip` with the appropriate string and leave trade-detail fields null. Emit a row even on skip.
- Stamp the `template_*` fields by calling `templateOf(fam)` (Step 5) — this is the cross-cut between sub-agents. Sub-agent A imports `templateOf` from `lib/backtest/template.mjs` and uses it; Sub-agent B is responsible for its implementation. Coordinate via the shared types file (Step 1).
- The engine's top-level export now returns `{rows, config}` where `rows` is `FixtureRow[]` (no aggregation).

**Files affected:** `lib/backtest/run-engine.mjs` (refactor).
**Expected output:** Engine emits one `FixtureRow` per linked bilateral family, including skip rows. No aggregation logic in this file.

### Step 5: Implement template + sport alias map (`lib/backtest/template.mjs`)

**Owner:** Sub-agent B (depends on Step 1).

Create `lib/backtest/template.mjs` exporting:

- `SPORT_ALIASES` — object mapping canonical sport id (`mlb`, `nhl`, `soccer`) to alias arrays (lowercase + alphanumeric). For v1, each canonical maps to itself plus a small set of plausible future labels (e.g., `mlb: ['mlb', 'baseball', 'majorleaguebaseball']`).
- `normalizeSport(raw)` — strips to alphanumeric lowercase, looks up in the alias index, returns the canonical id or `null` if no match.
- `templateOf(fam)` — returns a `Template` object per the schema doc:
  - For `category === 'sports'` with a known sport: `{template_id: 'sports.{sport}.kalshi-polymarket', template_label: 'Sports — {SPORT} (kalshi/polymarket)', category: 'sports', include_in_scoreboard: true}`.
  - For `category === 'sports'` with unknown sport: `{template_id: 'sports.unknown.kalshi-polymarket', ..., include_in_scoreboard: false}`.
  - For everything else: `{template_id: 'audit-only', template_label: 'Audit-only — non-sports', category: <fam.category>, include_in_scoreboard: false}`.

`templateOf` reads `fam.k_sport`, `fam.p_sport`, or `fam.sport` (in order of preference) — both legs always agree on sport in the current data per the 2026-04-24 diagnostic, but defensive ordering keeps it correct if that changes.

**Files affected:** `lib/backtest/template.mjs` (new).
**Expected output:** Pure function. Three sports templates resolve correctly; non-sports rows get the `audit-only` template; politics rows DO NOT crash even when `category` is a Polymarket event slug like `democratic-presidential-nominee-2028`.

### Step 6: Implement `aggregateByTemplate` (`lib/backtest/aggregate.mjs`)

**Owner:** Sub-agent B.

Create `lib/backtest/aggregate.mjs` exporting `aggregateByTemplate(fixtureRows)`. Behavior:

1. Filter to `fixtureRows.filter(r => !r.skip && r.template_include_in_scoreboard === true)`.
2. Group by `template_id`.
3. For each template compute the columns listed in `success-rubric.md` § "What the backtest produces" → templates CSV: `trades_simulated`, `win_rate`, `mean_net_edge_per_100`, `total_pnl_history`, `median_hold_days`, `disagreement_rate`, `void_rate`, `resolution_equivalence`.
4. **Definitions:**
   - `win_rate` = fraction of constituent fixtures with `net_dollars > 0`.
   - `mean_net_edge_per_100` = mean of `net_dollars` (trades are fixed at $100 deployment, so the per-$100 normalization is the identity).
   - `total_pnl_history` = sum of `net_dollars`.
   - `median_hold_days` = sorted-array median, lower-tiebreak via `Math.floor((n-1)/2)`.
   - `disagreement_rate` = fraction where (`cheap_state === 'won' && exp_state === 'won'`) OR (`cheap_state === 'lost' && exp_state === 'lost'`).
   - `void_rate` = fraction where `cheap_state === 'void' || exp_state === 'void'`.
   - `resolution_equivalence` = `'equivalent'` if all constituents agree (they should, since A3 filter is applied upstream); `'mixed'` otherwise.
5. Numeric formatting: `round2` for dollar amounts, `round4` for rates, integer for `median_hold_days`.
6. Sort: `total_pnl_history DESC, template_id ASC`.

**Files affected:** `lib/backtest/aggregate.mjs` (new).
**Expected output:** Pure function. Returns sorted array of template aggregates ready for CSV emission.

### Step 7: Refactor `scripts/backtest/run-backtest.mjs` to write three artifacts

**Owner:** Sub-agent B.

Rewrite the output section of the script:

1. Replace the single output path `a5-backtest-latest.csv` (and the `--out` override behavior) with three fixed paths:
   - `docs/pivot/artifacts/a5-backtest-templates-latest.csv` (scoreboard)
   - `docs/pivot/artifacts/a5-backtest-fixtures-latest.csv` (audit)
   - `docs/pivot/artifacts/a5-backtest-meta.json` (meta sidecar)
2. After the engine returns `{rows, config}`:
   - Write `fixtures-latest.csv` directly from `rows`. Sort: `template_id ASC, family_id ASC` before writing. CSV column order per schema doc § "Fixture CSV columns".
   - Compute `templates-latest.csv` via `aggregateByTemplate(rows)` and write. CSV column order per schema doc § "Templates CSV columns".
   - Write `meta.json` with the keys listed in the schema doc § "Meta JSON keys" — this includes `created_at`, `git_sha` (read via `git rev-parse HEAD`), engine/cost/template versions, all config knobs, A3 file path + SHA-256, settled & total family counts, and SHA-256 of both output CSVs computed AFTER they're written.
3. Remove the existing `metaLines` header injection — those values now live in the meta JSON, not as `#` comments inside the CSV body. The CSVs are pure data, byte-identical run-over-run.
4. Keep the existing CLI flags (`--a3`, `--include-ambiguous`, `--interval-hours`) and env knobs (`PMCI_BACKTEST_USE_STUB`, `PMCI_ENTRY_THRESHOLD_ABS`).
5. Drop the old `--out` flag — replaced by fixed paths. Print a stderr deprecation notice if anyone passes it.
6. Stamp `template_definition_version: 'sports-v1'` and `engine_version: 'arb-v1'` and `void_refund_model: 'full_refund_v1'` in the meta JSON.

**Files affected:** `scripts/backtest/run-backtest.mjs` (refactor).
**Expected output:** A single run produces all three artifacts at the fixed paths. CSV bodies contain no `#` headers, no timestamps, no env values.

### Step 8: Delete stale single-CSV artifact

**Owner:** Sub-agent B (after Step 7 verified).

Run `rm -f docs/pivot/artifacts/a5-backtest-latest.csv` and add a one-line note to any documentation referencing the old single-CSV path. Specifically check `docs/pivot/agents/a5-backtest-engine.md` for stale references and update them to point at the three new paths.

**Files affected:** `docs/pivot/artifacts/a5-backtest-latest.csv` (delete), `docs/pivot/agents/a5-backtest-engine.md` (touch).
**Expected output:** Old artifact gone; agent brief points at correct paths.

### Step 9: Tests for arb construction (`test/backtest/arb-trade.test.mjs`, `test/backtest/leg-resolver.test.mjs`)

**Owner:** Sub-agent A.

Test runner is `node --test`; tests live under `test/backtest/`. Mirror the style of `test/backtest/leg-payout.test.mjs`.

`leg-resolver.test.mjs` — cover:
- Kalshi YES leg with `winning_outcome: 'yes'` → `'won'`.
- Kalshi YES leg with `winning_outcome: 'no'` → `'lost'`.
- Kalshi NO leg with `winning_outcome: 'yes'` → `'lost'`.
- Polymarket YES leg matching team name in outcome → `'won'`.
- `winning_outcome: null` → `'void'`.
- `winning_outcome: ''` → `'void'`.
- `winning_outcome: 'unknown'` → `'void'`.

`arb-trade.test.mjs` — cover:
- Direction selection (`k_cheap` when `kYes < pYes`; `p_cheap` otherwise; tie goes to `k_cheap`).
- Sizing math: premiums sum to ≤ $100 within $0.01 tolerance for several price pairs.
- Both states `'won'` (windfall) → `disagreement` flag should propagate but the function itself just returns the states.
- Both states `'lost'` (wipe).
- Cheap won, expensive lost (the intended arb outcome) → positive gross.
- Cheap lost, expensive won (the OTHER intended arb outcome) → positive gross.
- Void on cheap leg only → expensive leg pays/receives normally; void leg refunded full premium + fees + slippage + lockup.
- Void on expensive leg only → mirror of above.
- Void on both legs → both refunded; net should be zero within rounding.
- Threshold gate at $1.00 / $100 — entry not triggered below threshold (this is upstream in the engine but assert via a wrapper test).
- Cost values: pass a small fixed input and assert net = gross − sum(costs) exactly.

**Files affected:** `test/backtest/arb-trade.test.mjs` (new), `test/backtest/leg-resolver.test.mjs` (new).
**Expected output:** `npm test` passes; new tests visible in output.

### Step 10: Tests for templates, aggregator, and determinism (`test/backtest/template.test.mjs`, `test/backtest/aggregate.test.mjs`, `test/backtest/determinism.test.mjs`)

**Owner:** Sub-agent B.

`template.test.mjs` — cover:
- `normalizeSport('MLB')`, `normalizeSport('Major League Baseball')`, `normalizeSport('mlb')` → `'mlb'`.
- `normalizeSport('cricket')` → `null`.
- `templateOf({category: 'sports', sport: 'mlb'})` → `include_in_scoreboard: true`, `template_id: 'sports.mlb.kalshi-polymarket'`.
- `templateOf({category: 'sports', sport: 'cricket'})` → `template_id: 'sports.unknown.kalshi-polymarket'`, `include_in_scoreboard: false`.
- `templateOf({category: 'democratic-presidential-nominee-2028'})` → `template_id: 'audit-only'`, `include_in_scoreboard: false`. (Critical — politics has polluted category strings; this must not crash.)

`aggregate.test.mjs` — cover:
- Synthetic input with mixed traded + skip rows. Aggregator filters skip rows out.
- Synthetic input with mixed `include_in_scoreboard` true/false. Aggregator filters audit-only rows out.
- Win rate, mean net edge, total PnL math against fixed inputs (3-row template with `net_dollars: [+10, -5, +20]` → win_rate=0.6667, total=25, mean=8.33).
- Disagreement detection: row with both states `'won'` increments disagreement_rate; row with both states `'lost'` also increments; (`'won'`, `'lost'`) does not.
- Void detection: any row with at least one void state increments void_rate.
- Sort order: `total_pnl_history DESC, template_id ASC`.
- Median tiebreak with even N uses `Math.floor((n-1)/2)`.

`determinism.test.mjs` — cover:
- Build a synthetic `rows` array (no DB), serialize fixture CSV twice via the same code path, assert byte equality.
- Same for templates CSV via aggregator output.
- Float formatting: `round2(1.005)` produces a stable string (document banker's-rounding behavior or use a fixed-precision formatter; do not rely on `toFixed` if Node version drift might change behavior).

**Files affected:** `test/backtest/template.test.mjs`, `test/backtest/aggregate.test.mjs`, `test/backtest/determinism.test.mjs` (all new).
**Expected output:** `npm test` passes; new tests visible.

### Step 11: End-to-end verification gate (sequential after both sub-agents merge)

**Owner:** Whoever runs the verification (typically the orchestrator chat).

1. `npm test` — all tests pass, no flakes.
2. `npm run pmci:backtest -- --interval-hours 1` — runs to completion against the live DB. No crashes.
3. Verify all three artifacts exist and have the expected shape:
   - `docs/pivot/artifacts/a5-backtest-templates-latest.csv`: 4 lines (1 header + 3 sports templates: mlb, nhl, soccer).
   - `docs/pivot/artifacts/a5-backtest-fixtures-latest.csv`: at least 1 + 88 = 89 lines (1 header + 88 active bilateral sports fixtures, mix of traded + skip rows). May include additional audit-only rows for non-sports linked families.
   - `docs/pivot/artifacts/a5-backtest-meta.json`: contains every key listed in the schema doc § "Meta JSON keys".
4. Run the script a second time. `diff` of both CSVs against the first run must be empty (byte-identical).
5. Confirm no `#`-prefixed comment lines exist in either CSV body (timestamps live only in `meta.json`).
6. Spot-check one fixture row in the audit CSV: confirm `direction`, `cheap_state`, `exp_state`, `void_refund_model: 'full_refund_v1'`, `entry_threshold_used`, `snapshot_interval_ms` are all populated for traded rows.

**Expected output:** All checks pass. If any fail, fix in the relevant sub-agent's lane and re-run the gate.

## Verification

Verification = Step 11. The full gate must pass before this phase is considered complete. Successor work (first interpretation doc fill-in) starts in a fresh chat that follows `docs/pivot/artifacts/a5-backtest-interpretation-template.md`, populating the placeholders from the three artifacts produced by this phase.

## Rollback

Single git revert of the merge commit restores the prior implementation:

- `lib/backtest/run-engine.mjs` returns to the directional-bet form.
- `scripts/backtest/run-backtest.mjs` returns to the single-CSV output.
- `lib/backtest/{leg-resolver,arb-trade,template,aggregate,types}.mjs` are deleted (they're new in this phase).
- `test/backtest/{arb-trade,leg-resolver,template,aggregate,determinism}.test.mjs` are deleted.

The old `docs/pivot/artifacts/a5-backtest-latest.csv` is regenerated automatically on the next backtest run after rollback. No DB schema changes in this phase, so no migration to revert.

## Out of Scope (do not let scope creep in)

- Politics, crypto, economics templates beyond the audit-only marker. Politics requires both A3-for-politics audit and a multi-outcome arb model (Polymarket politics is rarely binary). Both are deferred to a future phase.
- Multi-outcome arb construction. v1 is binary YES/NO on both venues.
- A1 outcome ingestion changes (`pmci.market_outcomes` is the source of truth; do not extend its scope).
- A2 cost-model changes other than calling `estimateCost` correctly with the right `side` per leg.
- The interpretation doc fill-in itself (skeleton already exists; first run gets filled in by the next chat).
- Category-column cleanup. Politics rows in `provider_markets` have category strings polluted by Polymarket event slugs (`democratic-presidential-nominee-2028` etc.). `templateOf` must handle these gracefully without crashing, but no DB cleanup is in scope.
- Snapshot-coverage timing diagnostic — parking-lot for the first interpretation doc fill-in chat, NOT this phase.
- New providers, new categories, E2/E3 work — explicitly forbidden by `CLAUDE.md` pivot guardrails.
- Per-template parameter tuning to inflate edge — overfitting; uniform parameters across templates.

> Plan files written to `docs/plans/`. To execute: tell Claude "follow the phase-pivot-arb-and-templates plan in docs/" — this triggers the Cursor Orchestrator.
