---
title: PMCI Scanner Plan v1
tags: [scanner, plan, v1, phase-0]
status: current
last-verified: 2026-05-08
sources:
  - "[[scanner-handoff-brief-2026-05-06]]"
  - "[[2026-05-06-mm-philosophy-pivot]]"
  - "[[hypothesis-tracker-template]]"
  - "[[published-edges-playbook]]"
  - "[[source-watch-list]]"
---

# PMCI Scanner Plan v1

**Created:** 2026-05-08
**Author:** Jay (operator) + Cowork planning session
**Status:** PLAN — build to follow review
**Scope:** Phase 0 of post-pivot creative roadmap (see `~/Documents/Claude/Projects/Prediction Machine/roadmap-mm-to-creative-practice-2026-04-27.md`)

---

## §1 Purpose

The scanner is a **discovery instrument**, not a trading system. Its output is a hypothesis log; its consumers are the operator reviewing the log + a downstream bot subscribing to alerts; its action is "test this" or "scale this" — never "place this trade right now."

The scanner exists because retail prediction-market traders consistently hunt only one inefficiency type (informational lag), the most-publicized and most-competed. The scanner widens the lens to all six known types and surfaces candidate edges with quantified evidence so they can be promoted (or retired) through a state machine.

The pillar question every scanner output must answer in one sentence:

> *"What feature of this market is this trader/bot exploiting that the consensus order book isn't pricing?"*

If a row can't answer this, it's noise.

---

## §2 Architecture (six layers)

Information flows top-down through six layers; each is a distinct responsibility.

1. **External Sources** — Kalshi (WS + REST), NBA `cdn.nba.com` play-by-play, reference pollers (CFTC, Polymarket leaderboard, FlowFrame, r/Kalshi). v1.5 adds MLB Stats API, NHL API, weather.gov, BLS, Pinnacle (paid).
2. **Ingestion (AWS Ohio t3.micro)** — single normalizer process wraps every event in a *provenance envelope* `{source_chain, observed_at, market_ticker, payload}` and writes to a raw event log on S3 + Postgres. The envelope is the most important shape in the system; the decay monitor uses `source_chain` to determine which link rotted when an edge stops working.
3. **Detection** — six lanes, two active in v1 (NBA informational lag + Structural dual-track). Other four lanes have empty tables provisioned so v1.5 turn-on requires no migration.
4. **Storage** — six per-type signal tables + `scanner_signals_unified` view + hypothesis tracker + `source_chains` + `measured_variables` + decay state + alerts (FK-gated to `live` hypotheses via trigger).
5. **Output** — daily report (overnight cron → S3 static HTML, hybrid format: paragraphs for `live`, one-liners for `scanning`); pager alerts (webhook → push/Slack/email, only on live hypotheses); weekly digest (Sunday cron with cross-day patterns + decay table + promotion candidates).
6. **External Interfaces** — manual trader (operator), `pmci-mm-runtime` (existing Fly app, primary v1 consumer), future Bot v2 (post-Chicago-VPS execution).

A diagram of this layout was generated during the planning dialogue (2026-05-08); recreate via `show_widget` if needed for documentation.

---

## §3 Inefficiency types & v1 scope

| Type | v1 status | Source rationale |
|---|---|---|
| Informational lag | **Active (NBA only)** | hoopR + cdn.nba.com WPA + Kalshi book lag — free feeds |
| Structural | **Active (dual track)** | Whelan replication needs only Kalshi history; microstructure needs only Kalshi L2 |
| Behavioral | Deferred v1.5 | Needs cross-market pattern data |
| Analytical | Deferred v1.5 | Needs Pinnacle/OddsAPI fair-value benchmark |
| Liquidity / capacity | Deferred v1.5 | Static analysis run weekly, not live scanner |
| Resolution-rule | Deferred v1.5 | Static analysis of contract specs |

Behavioral, capacity, and resolution-rule will live in `scanner_*_signals` empty tables from day one so v1.5 promotion requires no schema migration — only detector code and source ladder.

---

## §4 Source ladder

### 4.1 Active in v1

**Kalshi.** WebSocket (book deltas, trades) + REST (snapshots, market list, fills). Hardening references: `arshka/pykalshi` reconnect/backoff/state-restore patterns; `IntelIP/Neural`'s `WEBSOCKET_INTEGRATION_GUIDE.md` checklist (raw subscribe message format with `KALSHI-ACCESS-KEY`/`SIGNATURE`/`TIMESTAMP` headers, ~8 msg/sec/market sustainable load). Implementation extends existing `kalshi-pull.mjs`; do not swap to a third-party SDK.

**NBA.** `cdn.nba.com/static/json/liveData/playbyplay/playbyplay_{gameId}.json` polled every 3–5 seconds. No auth. Schema reference: `swar/nba_api` v3 endpoints (`PlayByPlayV3`). Filter pattern for made FGs: `shotResult == "Made" AND actionType != "freethrow"`.

**hoopR (`sportsdataverse/hoopR`).** Provides live WP per play. Two integration paths: (a) port WP coefficients to Python and run inference locally on cdn.nba.com event stream, (b) use `hoopR-py` package directly. Path (a) preferred (no R dependency on AWS Ohio).

**Reference pollers** (cron, light): CFTC filings RSS, Polymarket leaderboard scrape, FlowFrame public feed. See `source-watch-list.md`.

### 4.2 Deferred to v1.5

MLB Stats API, NHL `api-web.nhle.com`, weather.gov gridpoints, BLS news-release, Pinnacle (paid via OddsAPI when capital justifies).

---

## §5 Detection logic per active type

### 5.1 Informational Lag — NBA

```
for each NBA play-by-play event from cdn.nba.com:
  if event.actionType in ('made_3pt','made_2pt','foul','timeout','period_end'):
    wpa = hoopR.compute_wpa(pre_state, post_state)
    if abs(wpa) < p75_of_30day_rolling_window:
      continue  # not high-leverage
    market = lookup_kalshi_market_for_game(event.game_id)
    mid_pre = kalshi_book.mid_at(event.event_time - 1s)
    mid_post30 = kalshi_book.mid_at(event.event_time + 30s)
    if abs(mid_post30 - mid_pre) < 0.005:
      fair_wp = hoopR.live_wp(post_state)
      divergence = abs(fair_wp - mid_post30)
      if divergence > 0.03:
        log_signal(
          table='scanner_informational_lag_signals',
          source_chain='nba_pbp_v3 → cdn_poll_3s → wpa_p75_AND_mid_stable_30s_AND_diverge_3c',
          divergence_at_t_plus_30s=divergence,
          ...
        )
```

Three layered gates: WPA significance, Kalshi mid stability, fair-value divergence. Combined filter rejects ~80% of raw plays.

### 5.2 Structural — Track A (Whelan replication, daily batch)

Aggregates existing `pmci.mm_fills` rows into per-band per-side outcomes. Replicates Whelan paper's three primary findings: favorite-longshot bias on contracts >$0.50, lottery loss bias on <$0.10, 22pp gap between maker and taker outcomes.

```sql
INSERT INTO pmci.scanner_structural_signals (
  signal_id, observed_at, market_ticker, signal_strength_cents,
  source_chain_id, detector_track, price_band, side, trade_count,
  realized_yield_pct, band_window_start, band_window_end
)
SELECT gen_random_uuid(), now(), 'AGGREGATE',
       avg(yield_cents), :whelan_chain_id, 'whelan_band',
       price_band, side, count(*), avg(realized_yield_pct),
       date_trunc('day', now() - interval '1 day'),
       date_trunc('day', now())
FROM (
  SELECT
    CASE
      WHEN entry_price BETWEEN 0.50 AND 0.60 THEN '50-60c'
      WHEN entry_price BETWEEN 0.60 AND 0.70 THEN '60-70c'
      WHEN entry_price BETWEEN 0.70 AND 0.80 THEN '70-80c'
    END AS price_band,
    CASE WHEN was_maker THEN 'maker' ELSE 'taker' END AS side,
    (settled_value - entry_price) * 100 AS yield_cents,
    (settled_value - entry_price) / NULLIF(entry_price, 0) AS realized_yield_pct
  FROM pmci.mm_fills
  WHERE observed_at >= now() - interval '1 day'
    AND settlement_outcome IS NOT NULL
) t
WHERE price_band IS NOT NULL
GROUP BY price_band, side;
```

Reads existing data; no new sources.

### 5.3 Structural — Track B (microstructure scoring, live)

Port `sf-institutional-alpha-demo/src/sf_institutional_alpha/alpha_miner.py::QuantAlphaMiner.mine()` to Node.js. Per Kalshi book snapshot:

```
microprice = (bid * ask_size + ask * bid_size) / (bid_size + ask_size)
imbalance_ratio = (bid_size - ask_size) / (bid_size + ask_size)
spread_cents = (ask - bid) * 100
momentum_signal = price_change_simple_5min   # institutional-alpha: simple changes, not log returns, on [0,1] markets
confidence = w1*microprice_edge + w2*momentum + w3*imbalance*(1/spread) + w4*cross_venue_gap
             - liquidity_penalty - spread_penalty - vol_penalty
confidence = clamp(confidence, max_edge=0.04)
if abs(confidence) > threshold (initial: 0.02):
  log_signal(table='scanner_structural_signals', detector_track='microstructure', ...)
```

Initial weights from institutional-alpha repo defaults; tune after 4 weeks of accumulated data.

---

## §6 Three layers above hypotheses

The hypothesis itself is metadata + state. Three real-time layers operate on top:

**Compositor** (per-market, per-tick). Reads currently-active hypothesis signals on a `market_ticker`. Nets signals by `measured_variable` (same variable from opposite directions = cancellation, NOT summation). Produces `market_signals` rows with `net_edge_c`, `conflict_flag`, `active_hypothesis_ids`, `dominant_inefficiency_type`, `confidence_composite`. When `conflict_flag=true` and net edge is still above threshold, widen the spread (acknowledge uncertainty) rather than abstain.

**Strategy aggregator** (per-hypothesis, per-day). Reads compositor output filtered by hypothesis_id over rolling 30 days. Computes `hypothesis_capacity_state`: `observed_trades_30d`, `realized_edge_per_trade_c`, `realized_hold_seconds_p50`, `capacity_adjusted_daily_pnl_c = min(theoretical_daily_pnl, capacity_ceiling)`.

**Portfolio allocator** (per-week). Reads aggregator output for all `live` hypotheses + total capital. Solves a simple proportional allocation:

```
priority_score_i = capacity_adjusted_daily_pnl_c_i × confidence_i
allocation_i = total_capital × (priority_score_i / sum(priority_scores))
constraints:
  allocation_i ≤ max_position_size_c × max_concurrent_positions    # per-strategy capacity
  num_live ≤ 2 × (total_capital / $100)                            # concurrent live cap
  allocation_i ∈ {0} ∪ [$25, ∞)                                    # min threshold or zero
```

Compositor fires alerts in real time. Allocator runs weekly cron. **Alerts fire regardless of allocator state** but carry `tradable: bool` flag — bot ignores alerts on capital-starved strategies; operator dashboard shows them dimmed. Suppressing alerts because of capital state would lose the data on whether the strategy was firing during a no-budget period (precisely when you want to know "should I have allocated more?").

---

## §7 Three-stage flow: backtest → paper → live

A hypothesis in `testing` or `live` status has results in three stages:

**Backtest.** Replay `pmci.provider_market_snapshots` (~9.2M rows existing) chronologically. Apply hypothesis quoting/scoring logic against each snapshot. Simulate fills wherever market price would have crossed the simulated quote. Apply existing fee model from `lib/execution/fees.kalshi.mjs`. Write to `backtest_runs` + `backtest_fills`.

**Paper.** `pmci-mm-runtime` runs with `MM_RUN_MODE=paper`. Real-time market data, real quote computation, real inventory tracking — but the order-submit HTTP call is swapped for a local DB write to `mm_orders` with `mode='paper'`. Real latency, real queue position, real intraday liquidity shifts. The difference vs backtest: feels execution risk.

**Live.** `pmci-mm-runtime` with `MM_RUN_MODE=prod`. Same code, real Kalshi orders, `mm_orders.mode='live'`, `mm_orders.hypothesis_id` populated.

The comparison query that tells you whether to scale or retire:

```sql
SELECT stage,
       AVG(spread_capture_c) AS avg_spread_capture,
       AVG(adverse_c)        AS avg_adverse,
       AVG(fill_rate)        AS avg_fill_rate,
       COUNT(*)              AS n_observations
FROM (
  SELECT 'backtest'::text AS stage, spread_capture_c, adverse_c, fill_rate
    FROM pmci.backtest_runs WHERE hypothesis_id = :h
  UNION ALL
  SELECT 'paper', spread_capture_c, adverse_c, fill_rate
    FROM pmci.mm_pnl_snapshots WHERE hypothesis_id = :h AND mode = 'paper'
  UNION ALL
  SELECT 'live', spread_capture_c, adverse_c, fill_rate
    FROM pmci.mm_pnl_snapshots WHERE hypothesis_id = :h AND mode = 'live'
) t
GROUP BY stage;
```

The honest signal: "backtest +8c → paper +3c (execution drag) → live +1.2c (adverse selection)" tells you whether to scale or retire.

---

## §8 Schema

Full DDL. Apply via standard PMCI migration pattern (`supabase/migrations/`).

```sql
-- ============================================================================
-- REFERENCE: source chains
-- ============================================================================
CREATE TABLE pmci.source_chains (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_event     text NOT NULL,
  public_source   text NOT NULL,
  ingestion       text NOT NULL,
  detection       text NOT NULL,
  version         text NOT NULL,
  first_seen      timestamptz NOT NULL DEFAULT now(),
  last_seen       timestamptz NOT NULL DEFAULT now(),
  hit_count       int NOT NULL DEFAULT 0,
  miss_count      int NOT NULL DEFAULT 0,
  hit_rate_30d    numeric(5,4),
  hit_rate_ci_low numeric(5,4),
  hit_rate_ci_high numeric(5,4),
  UNIQUE (world_event, public_source, ingestion, detection, version)
);

-- ============================================================================
-- REFERENCE: measured variables (signal cancellation pivot)
-- ============================================================================
CREATE TABLE pmci.measured_variables (
  id              text PRIMARY KEY,
  display_name    text NOT NULL,
  description     text NOT NULL,
  namespace       text NOT NULL,
  scope           text NOT NULL,
  unit            text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- HYPOTHESES
-- ============================================================================
CREATE TYPE pmci.inefficiency_type AS ENUM (
  'informational_lag','structural','behavioral',
  'analytical','capacity','resolution_rule'
);

CREATE TABLE pmci.hypotheses (
  id              text PRIMARY KEY,
  name            text NOT NULL,
  status          text NOT NULL DEFAULT 'proposed' CHECK (status IN (
                    'proposed','scanning','testing','live','retired')),
  inefficiency_type pmci.inefficiency_type NOT NULL,
  measured_variable text NOT NULL REFERENCES pmci.measured_variables(id),
  edge_direction  text NOT NULL CHECK (edge_direction IN ('bullish_yes','bearish_yes','neutral')),
  edge_magnitude_c numeric(6,2) NOT NULL,
  confidence      numeric(4,3) NOT NULL,
  applies_when    jsonb NOT NULL DEFAULT '{}'::jsonb,
  invalidated_by  text[] NOT NULL DEFAULT '{}',
  ttl_seconds     int,
  expected_trades_per_day numeric(8,2),
  expected_edge_per_trade_c numeric(6,2),
  min_position_size_c int NOT NULL DEFAULT 500,
  max_position_size_c int NOT NULL DEFAULT 5000,
  avg_position_hold_seconds int,
  max_concurrent_positions int NOT NULL DEFAULT 1,
  theoretical_daily_pnl_c numeric(10,2) GENERATED ALWAYS AS (
    expected_trades_per_day * expected_edge_per_trade_c * (max_position_size_c::numeric / 100)
  ) STORED,
  mechanism_md    text NOT NULL,
  source_chain_id uuid NOT NULL REFERENCES pmci.source_chains(id),
  entry_rules     jsonb NOT NULL,
  exit_rules      jsonb NOT NULL,
  sizing_rules    jsonb NOT NULL,
  risk_gates      jsonb NOT NULL,
  falsification_test text NOT NULL,
  feature_importance jsonb,
  feature_importance_method text DEFAULT 'logistic_regression_perm',
  feature_importance_n int NOT NULL DEFAULT 0,
  feature_importance_updated_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  promoted_at     timestamptz,
  retired_at      timestamptz,
  retired_reason  text,
  realized_pnl_cents numeric(10,2) NOT NULL DEFAULT 0,
  last_validated_at timestamptz
);

CREATE INDEX hypotheses_status_idx ON pmci.hypotheses(status);
CREATE INDEX hypotheses_measured_variable_idx ON pmci.hypotheses(measured_variable);

-- ============================================================================
-- PER-TYPE TABLES (6 total; only 2 active in v1)
-- ============================================================================

-- Informational lag (NBA-only in v1)
CREATE TABLE pmci.scanner_informational_lag_signals (
  signal_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  observed_at     timestamptz NOT NULL DEFAULT now(),
  market_ticker   text NOT NULL,
  signal_strength_cents numeric(8,2) NOT NULL,
  source_chain_id uuid NOT NULL REFERENCES pmci.source_chains(id),
  hypothesis_id   text REFERENCES pmci.hypotheses(id),
  resolved_at     timestamptz,
  resolved_outcome text CHECK (resolved_outcome IN ('hit','miss','no_signal','timeout')),
  resolved_pnl_cents numeric(8,2),
  notes           jsonb NOT NULL DEFAULT '{}'::jsonb,
  game_id         text NOT NULL,
  period          int,
  game_clock_seconds_remaining int,
  event_type      text NOT NULL,
  wpa_at_event    numeric(6,4),
  wpa_percentile_30d numeric(5,2),
  pre_event_kalshi_mid numeric(5,4),
  post_event_kalshi_mid numeric(5,4),
  fair_wp_estimate numeric(5,4),
  divergence_at_t_plus_30s numeric(5,4),
  external_event_at timestamptz NOT NULL,
  kalshi_first_repriced_at timestamptz,
  lag_ms          bigint
);

-- Structural (Whelan + microstructure, dual-track via column)
CREATE TABLE pmci.scanner_structural_signals (
  signal_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  observed_at     timestamptz NOT NULL DEFAULT now(),
  market_ticker   text NOT NULL,
  signal_strength_cents numeric(8,2) NOT NULL,
  source_chain_id uuid NOT NULL REFERENCES pmci.source_chains(id),
  hypothesis_id   text REFERENCES pmci.hypotheses(id),
  resolved_at     timestamptz,
  resolved_outcome text,
  resolved_pnl_cents numeric(8,2),
  notes           jsonb NOT NULL DEFAULT '{}'::jsonb,
  detector_track  text NOT NULL CHECK (detector_track IN ('whelan_band','microstructure')),
  -- Whelan track
  price_band      text,
  side            text,
  trade_count     int,
  realized_yield_pct numeric(6,4),
  band_window_start timestamptz,
  band_window_end timestamptz,
  -- Microstructure track
  microprice      numeric(6,5),
  imbalance_ratio numeric(5,4),
  spread_cents    numeric(5,2),
  momentum_signal numeric(6,5),
  confidence_score numeric(5,4)
);

-- Behavioral / Analytical / Capacity / Resolution-rule (provisioned empty for v1.5)
CREATE TABLE pmci.scanner_behavioral_signals      (LIKE pmci.scanner_informational_lag_signals INCLUDING ALL);
CREATE TABLE pmci.scanner_analytical_signals      (LIKE pmci.scanner_informational_lag_signals INCLUDING ALL);
CREATE TABLE pmci.scanner_capacity_signals        (LIKE pmci.scanner_informational_lag_signals INCLUDING ALL);
CREATE TABLE pmci.scanner_resolution_rule_signals (LIKE pmci.scanner_informational_lag_signals INCLUDING ALL);
-- Override columns per type at v1.5; the LIKE clones are placeholders.

-- ============================================================================
-- COMPOSITOR + STRATEGY AGGREGATOR + PORTFOLIO ALLOCATOR
-- ============================================================================
CREATE TABLE pmci.market_signals (
  id              bigserial PRIMARY KEY,
  market_ticker   text NOT NULL,
  snapshot_ts     timestamptz NOT NULL,
  active_hypothesis_ids text[] NOT NULL,
  net_edge_c      numeric(6,2) NOT NULL,
  conflict_flag   boolean NOT NULL DEFAULT false,
  dominant_inefficiency_type pmci.inefficiency_type,
  dominant_hypothesis_id text REFERENCES pmci.hypotheses(id),
  confidence_composite numeric(4,3),
  UNIQUE (market_ticker, snapshot_ts)
);

CREATE TABLE pmci.hypothesis_capacity_state (
  hypothesis_id   text PRIMARY KEY REFERENCES pmci.hypotheses(id),
  computed_at     timestamptz NOT NULL DEFAULT now(),
  observed_trades_30d int NOT NULL,
  realized_edge_per_trade_c_30d numeric(6,2),
  realized_hold_seconds_p50 int,
  capacity_adjusted_daily_pnl_c numeric(10,2),
  capacity_ceiling_c numeric(10,2)
);

CREATE TABLE pmci.portfolio_allocations (
  id              bigserial PRIMARY KEY,
  computed_at     timestamptz NOT NULL DEFAULT now(),
  total_capital_c bigint NOT NULL,
  hypothesis_id   text NOT NULL REFERENCES pmci.hypotheses(id),
  allocated_capital_c bigint NOT NULL,
  allocation_reason text NOT NULL,
  active_until    timestamptz
);

-- ============================================================================
-- DECAY MONITOR
-- ============================================================================
CREATE TABLE pmci.hypothesis_decay_state (
  hypothesis_id   text PRIMARY KEY REFERENCES pmci.hypotheses(id),
  ref_window_start timestamptz NOT NULL,
  ref_window_end  timestamptz NOT NULL,
  current_window_start timestamptz NOT NULL,
  current_window_end timestamptz NOT NULL,
  psi_per_feature jsonb NOT NULL,
  ks_per_feature  jsonb NOT NULL,
  weighted_drift  numeric(6,4) NOT NULL,
  streaming_kswin_alarm boolean NOT NULL DEFAULT false,
  computed_at     timestamptz NOT NULL DEFAULT now(),
  triggers_retire boolean GENERATED ALWAYS AS (weighted_drift > 0.2 OR streaming_kswin_alarm) STORED
);

-- ============================================================================
-- ALERTS — FK trigger-gated to live hypotheses
-- ============================================================================
CREATE TABLE pmci.alerts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fired_at        timestamptz NOT NULL DEFAULT now(),
  hypothesis_id   text NOT NULL REFERENCES pmci.hypotheses(id),
  signal_id       uuid NOT NULL,
  signal_type     text NOT NULL,
  message         text NOT NULL,
  webhook_target  text NOT NULL,
  tradable        boolean NOT NULL,
  current_allocation_c bigint,
  delivered_at    timestamptz,
  delivery_status text
);

CREATE OR REPLACE FUNCTION pmci.enforce_alerts_live_only() RETURNS trigger AS $$
DECLARE h_status text;
BEGIN
  SELECT status INTO h_status FROM pmci.hypotheses WHERE id = NEW.hypothesis_id;
  IF h_status IS DISTINCT FROM 'live' THEN
    RAISE EXCEPTION 'alerts can only reference hypotheses with status=live, got %', h_status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER alerts_live_only_trg
  BEFORE INSERT ON pmci.alerts
  FOR EACH ROW EXECUTE FUNCTION pmci.enforce_alerts_live_only();

-- ============================================================================
-- BACKTEST INFRASTRUCTURE (three-stage flow)
-- ============================================================================
CREATE TABLE pmci.backtest_runs (
  id              bigserial PRIMARY KEY,
  hypothesis_id   text NOT NULL REFERENCES pmci.hypotheses(id),
  market_ticker   text NOT NULL,
  start_at        timestamptz NOT NULL,
  end_at          timestamptz NOT NULL,
  params_snapshot jsonb NOT NULL,
  spread_capture_c numeric(10,2),
  adverse_c       numeric(10,2),
  fee_net_c       numeric(10,2),
  fill_rate       numeric(5,4),
  n_quotes        int,
  n_fills         int,
  computed_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pmci.backtest_fills (
  id              bigserial PRIMARY KEY,
  run_id          bigint NOT NULL REFERENCES pmci.backtest_runs(id),
  snapshot_ts     timestamptz NOT NULL,
  side            text NOT NULL,
  price           numeric(5,4) NOT NULL,
  size_c          int NOT NULL,
  fill_type       text NOT NULL,
  pnl_c           numeric(8,2)
);

-- Tag existing tables with hypothesis_id + mode (live | paper)
ALTER TABLE pmci.mm_orders ADD COLUMN mode text NOT NULL DEFAULT 'live'
  CHECK (mode IN ('live','paper'));
ALTER TABLE pmci.mm_orders ADD COLUMN hypothesis_id text REFERENCES pmci.hypotheses(id);
ALTER TABLE pmci.mm_pnl_snapshots ADD COLUMN mode text NOT NULL DEFAULT 'live'
  CHECK (mode IN ('live','paper'));
ALTER TABLE pmci.mm_pnl_snapshots ADD COLUMN hypothesis_id text REFERENCES pmci.hypotheses(id);

-- ============================================================================
-- UNIFIED VIEW
-- ============================================================================
CREATE VIEW pmci.scanner_signals_unified AS
  SELECT signal_id, observed_at, market_ticker, signal_strength_cents,
         source_chain_id, hypothesis_id, 'informational_lag'::pmci.inefficiency_type AS type,
         resolved_at, resolved_outcome, resolved_pnl_cents
    FROM pmci.scanner_informational_lag_signals
  UNION ALL
  SELECT signal_id, observed_at, market_ticker, signal_strength_cents,
         source_chain_id, hypothesis_id, 'structural'::pmci.inefficiency_type AS type,
         resolved_at, resolved_outcome, resolved_pnl_cents
    FROM pmci.scanner_structural_signals;
-- v1.5: append UNIONs for behavioral/analytical/capacity/resolution_rule
```

---

## §9 Output specifications

### 9.1 Daily report (hybrid format)

Overnight cron → S3 static HTML. Two formats inside one report:

- **Live hypotheses get paragraphs.** Three sentences each: pillar question answer, source chain summary, recommended action (scale / hold / investigate).
- **Scanning hypotheses get one-liners.** `[type] market_ticker | edge: 4.2c | source: chain_id | hypothesis: H-2026-001 | status: scanning | n_resolved: 23/50`.

Skim target: 5–10 paragraphs (live) + ~50 one-liners (scanning) ≈ 15-minute morning review.

Ranking: `signal_strength_cents × hit_rate_30d` per source chain, with bootstrapped 95% CI. Rows whose CI lower bound includes 0.50 hit rate get a visual asterisk (point estimate is unreliable at this N).

### 9.2 Pager alerts

FK-trigger-gated to `live` hypotheses only. Webhook target configurable per operator preference. Payload:

```json
{
  "alert_id": "uuid",
  "hypothesis_id": "H-2026-001",
  "fired_at": "2026-05-09T...",
  "signal_type": "informational_lag",
  "message": "MINWSH lag: WPA -0.07, Kalshi mid stable 47s, divergence 4.2c",
  "tradable": true,
  "current_allocation_c": 5000
}
```

`tradable: false` if portfolio allocator has the strategy at $0; bot ignores, operator dashboard dims.

### 9.3 Weekly digest (Sunday cron)

Sections: cross-day patterns, decay table (which hypotheses tripped PSI/KSWIN this week), promotion candidates (which scanning hypotheses cleared posture thresholds), retirement list, capital allocation summary.

---

## §10 External interfaces (the outward arrow)

Three consumers of scanner output:

1. **Manual trader (operator).** Reads daily report + weekly digest. Acts via Kalshi UI on Path 2 published-edge trades. See `published-edges-playbook.md`.
2. **`pmci-mm-runtime` (Fly app, primary v1 consumer).** Subscribes to alert webhook. Acts on alerts where `tradable: true` and the alert's hypothesis is in the bot's allowlist. Per-hypothesis sizing from `sizing_rules` × portfolio allocator's `allocated_capital_c`. Risk gates layered per Freqtrade's `IProtection` ABC pattern (drawdown ladder, cooldown, per-market loss cap, latency gate). Pre-arm checklist required (see `published-edges-playbook.md` §7 — incorporates `rodlaf/KalshiMarketMaker` post-mortem of 6 specific Kalshi A-S parameter mistakes).
3. **Future Bot v2 (post-Chicago-VPS).** Same alert webhook. Lower-latency execution path. Scope: latency-sensitive informational-lag edges, GM-posterior fair-value MM. Deferred until Chicago VPS justified by capital + validated hypothesis.

---

## §11 v1 success criteria

**By end of build week 4:**
- Both active inefficiency-type detectors running on AWS Ohio
- ≥1 source chain per active type has produced ≥50 resolved rows
- Decay monitor running nightly (Frouros PSI/KS + River KSWIN streaming)
- Daily report rendering as static HTML to S3
- Pager alerts firing with FK enforcement
- At least one hypothesis has graduated `proposed → scanning`
- `pmci-mm-runtime` re-armed (post pre-arm checklist) and subscribing to alerts in test mode

**By end of build week 8:**
- ≥1 hypothesis has graduated `scanning → testing` (via STANDARD posture thresholds in `hypothesis-tracker-template.md`)
- Backtest replay produces apples-to-apples comparison vs paper
- ≥1 hypothesis has produced realized PnL > 0 in `paper` mode

---

## §12 Decisions deferred to v1.5

- Behavioral, analytical, capacity, resolution-rule detectors
- MLB / NHL ingestion
- Pinnacle / OddsAPI fair-value benchmark
- ML scoring layer (one model max, after 4 weeks of accumulated data; replaces `signal_strength_cents` term, not the rest of the ranking formula)
- Chicago VPS migration for latency-sensitive execution
- GM-posterior fair-value in pmci-mm-runtime (3 wks effort, after VPIN gate proves stable)
- Wallet-archaeology adaptation (cross-day L2 fingerprint pattern recognition)

---

## §13 Repo extracts inventory

Sixteen repos researched during planning (2026-05-06 to 2026-05-08); verdicts:

**v1 direct usage (use immediately):**
- `swar/nba_api` — NBA event source (use cdn.nba.com URL directly from Node, mirror v3 schema)
- `sportsdataverse/hoopR` — NBA live WP coefficients
- `IFCA-Advanced-Computing/frouros` — PSI/KS production library, swap for ATP repo's research code
- `sf-institutional-alpha-demo` — `features.py` + `alpha_miner.py` edge formula port

**v1 transplant patterns (lift logic, not deps):**
- `arshka/pykalshi` — WS reconnect/resubscribe state machine
- `IntelIP/Neural` — `WEBSOCKET_INTEGRATION_GUIDE.md` hardening checklist
- `jheusser/vpin` — 30-line VPIN core for MM bot toxicity gate
- `nickchuisme/glosten-milgrom` — informed-quoter posterior for MM v2

**v1.5 references:**
- `online-ml/river` — streaming KSWIN/ADWIN for hit-rate-error change-point alarms
- `JakeKandell/NBA-Predict` — z-score-differential pattern + walk-forward standardization for NBA scoring model
- `andrewderango/NHL-Game-Probabilities` — NHL API scrape pattern (when v1.5 NHL turns on)
- `Polymarket/poly-market-maker` — `BaseStrategy` interface for v2 MM rewrite
- `freqtrade/freqtrade` — `IProtection` ABC for layered drawdown ladder

**Reference / pre-arm checklists:**
- `rodlaf/KalshiMarketMaker` post-mortem — 6 specific Kalshi A-S parameter bugs (read before re-arming pmci-mm-runtime)
- `hummingbot/hummingbot` `BudgetChecker.adjust_candidate()` — pre-trade adjust pattern
- `vnpy/vnpy` `check_risk()` — pre-trade gate chain reference

**Skipped:**
- `evidentlyai/evidently` — too heavy for t3.micro
- `SeldonIO/alibi-detect` — TF dep too heavy (port multivariate-correction logic only)
- `warproxxx/poly-maker` — author confirms unprofitable; architectural validation only
- `trumanmai/Cross-Asset-Liquidity-Scanner` — misleadingly named (price outliers, not liquidity), only the threshold-slider UX is useful
- `callmevojtko/Recommended-Bets-By-Email-MLB` — train/test methodology broken; useful only for HTML email template skeleton
- `SergioWatanabe/-ATP-Prediction-Engine-Alpha-Decay-Market-Regime-Analysis` — research-grade code; use the *idea* (weighted-drift), implement via Frouros

---

## §14 Non-goals

The scanner does NOT:
- Execute trades (alerts only; trade decision is bot/operator)
- Operate at sub-50ms latency (v2 territory, post-Chicago-VPS)
- Subscribe to paid data feeds (v1.5+)
- Run ML models (v1.5; one model max after 4 weeks of data)
- Replace `pmci-mm-runtime` quoting logic (it feeds it)
- Trade Polymarket (US user, ToS)

---

## Appendix A: Cross-references

- `~/Documents/Claude/Projects/Prediction Machine/scanner-handoff-brief-2026-05-06.md` — origin brief
- `~/prediction-machine/docs/research/2026-05-06-mm-philosophy-pivot.md` — underlying research
- `~/prediction-machine/docs/strategies/hypothesis-tracker-template.md` — companion (state machine, posture, worked example)
- `~/prediction-machine/docs/strategies/published-edges-playbook.md` — Path 2 manual edges + bot pre-arm checklist
- `~/prediction-machine/docs/research/source-watch-list.md` — structural-change tracking sources
- `~/prediction-machine/CLAUDE.md` — repo invariants

## Appendix B: Build sequencing

Suggested order to land in 4 weeks:

| Week | Deliverable |
|---:|---|
| 1 | Schema migration applied; `source_chains` + `measured_variables` seeded; AWS Ohio normalizer process running with provenance envelope writes |
| 2 | NBA detector (cdn.nba.com poller + hoopR WP integration) emitting rows for 1+ hypothesis in `proposed` status |
| 2 | Structural Track A SQL daily cron writing rows |
| 3 | Structural Track B microstructure scoring port (alpha_miner) running on Kalshi book snapshots |
| 3 | Frouros PSI/KS swap-in for decay monitor; nightly cron writing `hypothesis_decay_state` rows |
| 4 | Daily report rendering to S3; pager alert webhook + FK trigger live |
| 4 | `pmci-mm-runtime` re-arm with VPIN gate (jheusser/vpin port); subscribed to alert webhook in test mode |
