---
title: MM v2 — Universe selection rubric (Kalshi DEMO → production scaling)
status: draft
last-verified: 2026-05-01
sources:
  - supabase/migrations/20260225000001_pmci_init.sql
  - supabase/migrations/20260331000001_sports_market_fields.sql
  - supabase/migrations/20260416000002_pmci_volume24h_column.sql
  - supabase/migrations/20260417000001_pmci_market_templates.sql
  - supabase/migrations/20260428100001_pmci_mm_w2_schema.sql
  - supabase/migrations/20260430130000_pmci_poly_w1.sql
  - docs/plans/phase-mm-mvp-plan.md
  - docs/plans/phase-poly-wallet-indexer-plan.md
  - /Users/jaylenjohnson/audits/post-pivot-review/synthesis/post-pivot-roadmap.md
  - /Users/jaylenjohnson/audits/post-pivot-review/synthesis/cross-cutting-findings.md
  - docs/decision-log.md
---

# Universe selection rubric

## 1. Catalog — `pmci.provider_markets` inputs (Kalshi rows, read-only today)

Baseline table definition (`20260225000001_pmci_init.sql`); later migrations add **`volume_24h`**, **`market_template`**, **`template_params`**, **`sport`, `event_type`, `game_date`, `home_team`, `away_team`** (sports classifier). Polymarket indexer tables exist per **ADR-009** (`20260430130000_pmci_poly_w1.sql`) but **writes are not yet live until indexer W2** — treat flow fields below as forward-looking unless joined manually.

| Column / join | Availability | MM relevance |
|---------------|--------------|--------------|
| `id` | ✅ | FK for `mm_market_config.market_id`, depth |
| `provider_market_ref` | ✅ | Kalshi ticker (native id) |
| `title`, `category`, `status` | ✅ | Template + lifecycle |
| `open_time`, `close_time` | ✅ | Time-to-event, rotator decay |
| `volume_24h` | ✅ column; **nullable in practice** on rotator cohort (see §5) | Capacity / attention proxy |
| `market_template`, `template_params` | ✅ columns; often null | Rule-based bucketing |
| Sports denorm fields | ✅ when ingested | Sub-model routing |
| `metadata` jsonb | ✅ | Provider extras (e.g. series) |
| Latest snapshot / depth | ✅ via joins to `provider_market_snapshots`, `provider_market_depth` | Spread, mid, data freshness |

**Not in `provider_markets` alone:** live best bid/ask — comes from **depth** or snapshot tables.

---

## 2. Candidate features (5–8) with hypothesized sign

| # | Feature | Hypothesized sign on MM edge | Notes / magnitude intuition |
|---|---------|------------------------------|-----------------------------|
| F1 | **Quoted spread** (from latest `provider_market_depth.spread_cents`) | **+** | Wider inside-Kalshi spread ⇒ more capture per round-trip; too wide may mean illiquidity / stuck inventory (nonlinear). |
| F2 | **Depth sample rate** (rows per hour in `provider_market_depth`) | **+** | Proxy for feed health + activity; DEGRADER **#8** warns retention without expansion risk. |
| F3 | **EMA of `volume_24h`** (when populated) | **+** (capped) | Flow indicates rotation & fill opportunity; saturates at venue limit. |
| F4 | **Time-to-close** (hours) | **∩** (sweet spot) | Too short → gamma/close-out risk; too long → capital tie-up. Mid window **+**. |
| F5 | **Poly linked leg** (exists in `v_market_links_current` for Poly side) | **+** | Better fair-value blend + future flow signal; DEGRADER **#4** notes fetch failure rates. |
| F6 | **Category prior** (sports / politics / crypto / econ vs “rotator weather”) | **±** | Operator prior: retail-heavy + model legibility **+**; exotic templates **−** until models exist. |
| F7 | **Sharp-flow pressure** (post–indexer W5, `poly_market_flow_5m` + sharp wallet set) | **−** | High sharp net flow ⇒ adverse selection; DEGRADER **#9** (~5m rollup latency) caps usefulness. |
| F8 | **Settlement clarity** (template known + resolution source stable) | **+** | Reduces tail risk from rule disputes. |

---

## 3. Scoring function (v2.0 linear)

Let each feature $f_i$ be mapped to $[0,1]$ by min–max or capped transforms (documented per deployment). **Total score:**

$$
S = \sum_{i=1}^{8} w_i \cdot f_i,\quad \sum w_i = 1,\ w_i \ge 0
$$

**Default weights (illustrative, sum 1.0):**  
F1 0.20, F2 0.15, F3 0.10, F4 0.10, F5 0.15, F6 0.10, F7 0.10 (0 until data exists), F8 0.10.

**Cutoff policy:** markets with $S < S_{\min}$ are excluded from automated enablement. **Floor rule (this doc):** $S_{\min}$ = minimum $S$ among the **current 8-ticker rotator cohort** (ADR-010), so any new candidate must beat the weakest admitted market unless operator overrides.

---

## 4. Feature mapping for scoring run (2026-05-01 cohort)

**Tickers (floor cohort):**  
`KXHIGHTNOLA-26MAY01-T70`, `KXHIGHLAX-26MAY01-T68`, `KXHIGHTHOU-26MAY01-T70`, `KXHIGHDEN-26MAY01-T56`, `KXHIGHTMIN-26MAY01-T51`, `KXHIGHTSATX-26MAY01-T67`, `KXHIGHTBOS-26MAY01-T61`, `KXLOWTCHI-26MAY01-T41`.

**Live DB snapshot (observed 2026-05-01 ~16:13Z, `DATABASE_URL` read-only query):**

| Ticker | `depth_rows` (lifetime) | Latest `mid_cents` | Latest `spread_cents` | Latest depth `observed_at` |
|--------|-------------------------|--------------------|-----------------------|----------------------------|
| KXHIGHTNOLA-26MAY01-T70 | 91,891 | 25.5 | 49 | 2026-05-01T16:13:16.998Z |
| KXHIGHLAX-26MAY01-T68 | 88,351 | 55.5 | 87 | 2026-05-01T16:13:40.009Z |
| KXHIGHTHOU-26MAY01-T70 | 80,506 | 25.5 | 49 | 2026-05-01T16:13:16.998Z |
| KXHIGHDEN-26MAY01-T56 | 87,509 | **null** | **null** | 2026-05-01T16:13:40.009Z |
| KXHIGHTMIN-26MAY01-T51 | 87,509 | 25.5 | 49 | 2026-05-01T16:13:15.997Z |
| KXHIGHTSATX-26MAY01-T67 | 29,855 | 25.5 | 49 | **2026-05-01T00:11:41.303Z** (~16h stale vs peers) |
| KXHIGHTBOS-26MAY01-T61 | 87,509 | 25.5 | 49 | 2026-05-01T16:13:15.997Z |
| KXLOWTCHI-26MAY01-T41 | 87,509 | 44.5 | 87 | 2026-05-01T16:13:40.009Z |

All eight: `category = mm-rotator`, `volume_24h = null`, `market_template = null`, `snapshot_rows = 0` (no `provider_market_snapshots` rows for these ids in this query).

**Derived feature values (0–1) for exercise:**

- **F1 spread:** `min(1, spread/90)` with null spread → `0`.
- **F2 depth volume:** `min(1, depth_rows / 95000)`.
- **F3 volume_24h:** `0.3` flat when null (weak prior).
- **F4 time-to-close:** all ~12–20h to `close_time` → set `0.85` (same band).
- **F5 Poly link:** `0` (no evidence of linked Poly leg in this run).
- **F6 category:** `0.5` baseline for demo weather rotator.
- **F7 sharp flow:** `0` (indexer W2 not shipping yet).
- **F8 settlement clarity:** `0.7` (exchange-traded weather contracts; operator curated).

**F2b feed freshness (override for transparency):** multiply F2 by `1` if latest depth within 2h, else `0.4`. Applied below.

| Ticker | F1 | F2 (with freshness) | F3 | F4 | F5 | F6 | F7 | F8 | **S** (default weights) |
|--------|-----|---------------------|----|----|----|----|----|----|-------------------------|
| KXHIGHTNOLA-26MAY01-T70 | 0.544 | 0.967 | 0.3 | 0.85 | 0 | 0.5 | 0 | 0.7 | **0.485** |
| KXHIGHLAX-26MAY01-T68 | 0.967 | 0.930 | 0.3 | 0.85 | 0 | 0.5 | 0 | 0.7 | **0.568** |
| KXHIGHTHOU-26MAY01-T70 | 0.544 | 0.847 | 0.3 | 0.85 | 0 | 0.5 | 0 | 0.7 | **0.464** |
| KXHIGHDEN-26MAY01-T56 | **0** | 0.920 | 0.3 | 0.85 | 0 | 0.5 | 0 | 0.7 | **0.343** ← weakest |
| KXHIGHTMIN-26MAY01-T51 | 0.544 | 0.967 | 0.3 | 0.85 | 0 | 0.5 | 0 | 0.7 | **0.485** |
| KXHIGHTSATX-26MAY01-T67 | 0.544 | **0.126** | 0.3 | 0.85 | 0 | 0.5 | 0 | 0.7 | **0.356** |
| KXHIGHTBOS-26MAY01-T61 | 0.544 | 0.967 | 0.3 | 0.85 | 0 | 0.5 | 0 | 0.7 | **0.485** |
| KXLOWTCHI-26MAY01-T41 | 0.967 | 0.920 | 0.3 | 0.85 | 0 | 0.5 | 0 | 0.7 | **0.569** |

**Floor cutoff $S_{\min}$:** **`0.343`** (approximately **KXHIGHDEN-26MAY01-T56**, dominated by missing mid/spread on latest depth snapshot). Operator may treat SAN Antonio (`0.356`) as the operational weak link depending on whether stale depth is considered temporary.

---

## 5. Indexer W2+ contributions (planned)

Per `docs/plans/phase-poly-wallet-indexer-plan.md` **Build sequence**:

| Week | Artefact | Universe rubric uplift |
|------|-----------|-------------------------|
| W2 | `poly_wallet_trades` historical | Condition-level traded notional proxies |
| W3 | Live tail + finality | Timely F7 signal |
| W4 | Positions + nightly stats | Wallet concentration |
| W5 | Sharp/degen + **`poly_market_flow_5m`** + NOTIFY | Toxicity-aware F7; “degen exuberance” features |

Concrete add-ons: rolling sharp net notional vs degen net, hit-rate priors (**DEGRADER #10** warns hand-tuned thresholds), abnormal burst flags (toxicity pre-whisper).

---

## 6. How the rubric runs — operational sketch

**Modes (pick one primary):**

1. **On-demand CLI / admin job** (`npm run mm:universe-score`) — deterministic, auditable JSON to operator.
2. **Nightly cron** after indexer stats refresh — aligns with Poly W4.
3. **API** (`GET /v1/mm/universe-candidates`) — optional; gated like other MM admin routes (`src/server.mjs` pattern).

Recommendation: **start with on-demand + nightly**; avoid coupling rotator’s hot path to Poly latency.

---

## 7. `pmci.mm_market_universe_candidates` — schema sketch (no migration)

```sql
-- DESIGN ONLY — do not apply without dedicated migration + RLS review.
CREATE TABLE pmci.mm_market_universe_candidates (
  id                    bigserial PRIMARY KEY,
  provider_market_id    bigint NOT NULL REFERENCES pmci.provider_markets(id),
  scored_at             timestamptz NOT NULL DEFAULT now(),
  score                 numeric NOT NULL,
  feature_vector        jsonb NOT NULL DEFAULT '{}'::jsonb,
  weights_snapshot      jsonb NOT NULL DEFAULT '{}'::jsonb,
  decision              text CHECK (decision IN ('admit','reject','manual_review')),
  notes                 text
);

CREATE INDEX idx_mm_universe_candidates_time
  ON pmci.mm_market_universe_candidates (scored_at DESC);
CREATE UNIQUE INDEX ux_mm_universe_candidates_market_latest
  ON pmci.mm_market_universe_candidates (provider_market_id, scored_at);
```

Retention: operator policy (e.g. keep 90 days). Service-role-only matches other `mm_*` tables (**Pre-W2 #3** pattern).

---

## 8. Audit linkage

Roadmap §6 **Q7** — universe-selection rubric called “categorical, not quantitative”; this doc codifies **quantitative v2.0**.

Cross-cutting remainder bullet (*Universe selection rubric is categorical, not quantitative* — agent 02 §3.16 Q2): addressed by §3–§4 methodology, pending implementation (`cross-cutting-findings.md` §4 remainder list).
