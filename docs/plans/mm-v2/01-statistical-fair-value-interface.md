---
title: MM v2 — Statistical fair-value interface (v0 contract + migration)
status: draft
last-verified: 2026-05-01
sources:
  - lib/mm/fair-value.mjs
  - lib/mm/orchestrator.mjs
  - test/mm/fair-value.test.mjs
  - docs/plans/phase-mm-mvp-plan.md
  - /Users/jaylenjohnson/audits/post-pivot-review/synthesis/cross-cutting-findings.md
  - /Users/jaylenjohnson/Documents/Claude/Projects/Prediction Machine/_inbox/thesis-brainstorm-kalshi-poly-structures.md
  - docs/decision-log.md
---

# Statistical fair-value interface (v0 → v2)

## 1. v0 interface contract (must preserve)

Source of truth: `lib/mm/fair-value.mjs`. The orchestrator calls `updateFairValue` with Kalshi snapshot fields and carries mutable state per ticker (`lib/mm/orchestrator.mjs`).

### 1.1 Exported constants

| Symbol | Value | Role |
|--------|-------|------|
| `HALF_LIFE_MS` | `30000` | EMA half-life for blended mid |

### 1.2 `blendKalshiPolyMid(midKalshiCents, midPolyCents, lk, lp)`

- **Returns:** `number | null` (YES-implied cents, same units as today).
- **Rules:** If Kalshi mid missing or non-finite → `null`. If Poly mid present and finite → liquidity-weighted mean with defaults `Lk=1`, `Lp=1` when weights missing or non-positive. Else Kalshi-only.

### 1.3 `emaHalfLifeStep(state, blendedMidCents, nowMs, dtMs?)`

- **State shape:** `{ emaCents?, lastEmitMs?, updates? }` (plus fields returned on output).
- **Cold start:** First finite blended mid seeds `emaCents = blended`, `confidence = 0.08`, `updates` increment.
- **Step:** α = `1 - exp(-ln(2) * dt / HALF_LIFE_MS)`; `confidence = min(1, updates/12)`.
- **Returns:** `{ emaCents, lastEmitMs, updates, confidence, stalenessMs }`.

### 1.4 `updateFairValue(p)` — primary contract

**Input `p`:**

| Field | Type | Required | Semantics |
|-------|------|----------|-----------|
| `state` | object | no | Prior EMA carry (see below) |
| `midKalshiCents` | number | yes | Kalshi YES-implied mid (cents) |
| `midPolyCents` | number \| null \| undefined | no | Poly YES-implied mid when linked |
| `weightKalshiLiquidity` | number \| null \| undefined | no | Kalshi liquidity weight |
| `weightPolyLiquidity` | number \| null \| undefined | no | Poly liquidity weight |
| `nowMs` | number | yes | Wall-clock ms for EMA step |
| `dtMs` | number \| null \| undefined | no | Explicit Δt; else derived from `state.lastEmitMs` |
| `midObservedMs` | number \| null \| undefined | no | Source tick time → drives `staleness_ms` |

**Output (success path):**

| Field | Semantics |
|-------|-----------|
| `fair_value_cents` | Rounded/smoothed fair value (cents) |
| `confidence` | 0…1 ramp from update count |
| `staleness_ms` | Age of inbound mid vs `nowMs` when `midObservedMs` set; else EMA step staleness |
| `blended_mid_cents` | Pre-EMA blend |
| `raw` | Diagnostics (`ema_updates`, or `{ skipped: true }`) |
| `carry` | Next-tick persistent state: `emaCents`, `lastEmitMs`, `updates`, `confidence` |

**Output (degenerate paths):** When blend null/invalid, returns prior `fair_value_cents` from carry (possibly `NaN`), `confidence` from carry, `blended_mid_cents` null, `raw.skipped`, and preserves carry fields.

### 1.5 `createFairValueMarketState()`

Returns `{}` — empty initial carry.

### 1.6 Implementation note (no code change in this track)

In the skip branch, `updateFairValue` reads `st.staleMs`; live state uses `stalenessMs` from `emaHalfLifeStep`. v2 work should treat **orchestrator-passed `midObservedMs`** as the authoritative staleness source for risk (already true on the happy path).

---

## 2. Thesis #1 mapping (“statistical model edge”)

The brainstorm doc ranks **thesis #1 — statistical-model edge (sports)** as the top capital-efficiency thesis: proprietary forecasts vs thin Kalshi books, with Polymarket as a retail-sentiment reference (`_inbox/thesis-brainstorm-kalshi-poly-structures.md`).

**How v2 subsumes thesis #1:** The same `updateFairValue` surface becomes a **plug-in**: *v0* uses EMA-of-mid; *v2* replaces the internal blend+EMA block with a model that outputs a point estimate (and optional variance) still serialized as `fair_value_cents` + `confidence`. Inventory, quoting, risk, and P&L attribution stay unchanged — only the fair-value generator swaps. That is exactly “model-driven edge” without forking the MM hot path.

---

## 3. Per–in-MVP category model sketches (v2.0)

MVP plan (`docs/plans/phase-mm-mvp-plan.md`) scopes categories as **sports, politics, crypto, economics** for the MM thesis. Below: **features**, **simplest model that should beat EMA+Poly** (hypothesis), **cheap training data**.

### 3.1 Sports

- **Features:** Elo / Glicko strength, rest/travel, injury flags (binary), closing-line movement proxy from Kalshi+Poly mids, home field, implied vol from order-book spread.
- **Simplest beat-EMA model:** Regularized logistic (or isotonic-corrected linear) on tabular features → win probability; for totals/spreads use normal–CDF approximations with league-specific variance.
- **Cheap data:** Public schedules/results (CSV/API), curated injury lists, Kalshi historical mids from `pmci.provider_market_snapshots` / `provider_market_depth` (already observed). Polymarket mids for cross-venue normalization when linked.

**Sub-models (examples):**

| Event type | Why separate | Extra features |
|------------|--------------|----------------|
| NBA / NHL **single game** moneyline | High frequency, rich Elo signal | Back-to-back, minutes limits |
| **Series** NHL/NBA futures | Joint progression; correlations | Series score state |
| Soccer **match winner** | Low-scoring Poisson structure | Expected goals summaries |
| **Win totals / season specials** | Long horizon; variance scaling | Pace, roster deltas |

### 3.2 Politics

- **Features:** Polling aggregates (moving average + house effects), endorsement/fundraising deltas, partisan baseline, calendar to election, analogous race embeddings.
- **Simplest beat-EMA model:** Hierarchical logistic with time decay on polls beats raw EMA when events have **scheduled information releases** EMA reacts to late.
- **Cheap data:** Public poll CSVs (538-style replication inputs), FEC summaries, Kalshi/Poly history for same-race links.

**Sub-models:** Primary vs general vs ballot measure; **incumbent** vs open seat.

### 3.3 Crypto

- **Features:** Spot returns (multiple venues), implied vol from options or realized vol, funding (where applicable), event-specific strike/time (e.g., “BTC above X on date”).
- **Simplest beat-EMA model:** Drift + jump mixture with **event-time** conditioning (hours-to-expiry) beats static EMA when gap risk dominates.
- **Cheap data:** Exchange public OHLC APIs, on-chain aggregates; internal Kalshi/Poly mids.

### 3.4 Economics / macro prints

- **Features:** Economist survey consensus, nowcasts from public dashboards, whisper ranges, prior-release surprise distribution.
- **Simplest beat-EMA model:** Distributional model for surprise (Gaussian or Student‑t mixture) mapped to threshold contract probability beats EMA ahead of CPI/NFP bombs.
- **Cheap data:** FRED / public survey archives, scraped consensus panels (license-respecting).

---

## 4. `fair_value_version` — column spec (design only)

**Table:** `pmci.mm_market_config` (see `supabase/migrations/20260428100001_pmci_mm_w2_schema.sql`).

**New column (not migrated in this track):**

```sql
fair_value_version text NOT NULL DEFAULT 'v0'
  CHECK (fair_value_version IN ('v0', 'v2_stat'));  -- extend enum as implementations ship
```

Optional future: separate `fair_value_params jsonb` for per-market model routing (sport template, lookahead hours, volatility override).

### 4.1 Runtime selection (v0 → v2)

1. Orchestrator reads `fair_value_version` with other config per market.
2. **`v0`:** Current code path (`blendKalshiPolyMid` → `emaHalfLifeStep`).
3. **`v2_stat`:** New module implements same `updateFairValue` signature (or a thin wrapper that maps model output → the same return shape). State blob may embed model-specific recursion (persist in-process only; DB persistence is optional and out of MVP).
4. **A/B guard:** Quote/risk logs include `fair_value_version` in payload for forensics (`mm_orders.payload` already `jsonb`).

### 4.5 Audit cross-links

- DEGRADER **#11** (*Polymarket-blend liquidity measure not pinned*, `cross-cutting-findings.md` §4 remainder list): v2 should define liquidity inputs consistently for any continued Poly blend.
- DEGRADER **#3** (*P&L attribution formula*, top-10 table): fair-value versioning must align with Contract R7 inputs (`fair_value_at_fill` semantics) documented elsewhere — **no schema change implied here.**

---

## 5. Preconditions flagged “not yet”

| Item | Precondition |
|------|----------------|
| v2 inference service | Deployed artifact or inlined model with deterministic replay |
| Labeled outcomes for fit | Settlement history + sports/politics results joinable to `provider_markets` |
| Poly liquidity feature | Depends on indexer W2+ rollups (`poly_market_flow_5m` per ADR-009 plan) |

These are **not** in `lib/mm/fair-value.mjs` today; they are prerequisites for swapping implementation behind the same interface.
