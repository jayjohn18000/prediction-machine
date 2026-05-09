---
title: PMCI Hypothesis Tracker Template
tags: [hypothesis, tracker, template, v1, phase-0]
status: current
last-verified: 2026-05-08
sources:
  - "[[scanner-plan-v1]]"
  - "[[scanner-handoff-brief-2026-05-06]]"
---

# Hypothesis Tracker Template

**Created:** 2026-05-08
**Status:** TEMPLATE — instances live in `pmci.hypotheses` table
**Companion:** `scanner-plan-v1.md` (architecture), `published-edges-playbook.md` (Path 2 manual edges)

---

## §1 Purpose

The hypothesis tracker is the operator's primary interface to the scanner. It records every measurable claim about edge that has ever been worth investigating, manages each claim through a state machine, and auto-retires claims when the underlying signal decays.

A hypothesis is a **signal, not a trading decision**. It says: "when conditions X are true, fair value is Y cents higher than the displayed market." The decision to quote / take / pass comes from the *compositor* layer above hypotheses, which nets multiple signals on the same market.

Hypotheses are a closed feedback loop: scanner surfaces candidates → tracker promotes through stages → live trades produce data → decay monitor retires when signal dies. The template below is the schema each hypothesis instance must populate.

---

## §2 State machine

A hypothesis progresses through five states. Transitions are gated by posture thresholds (§4). The decay monitor (§6) automates `live → retired`.

```
proposed  →  scanning  →  testing  →  live  →  retired
   │            │            │          │
   │            │            │          └─→ (no demotion path; if degraded, retired only)
   │            │            └─→ retired (failed posture gate)
   │            └─→ retired (failed posture gate, falsified)
   └─→ retired (manual)
```

`proposed`: documented but not yet detecting. Cheap state — costs nothing.
`scanning`: detecting and logging signals; no trades. Most hypotheses live here longest.
`testing`: paper trades or tiny real trades; gathering execution data.
`live`: full sizing per `sizing_rules`; consumes capital allocator budget.
`retired`: archived for institutional memory. 30-day cool-down before re-proposal of any variant.

---

## §3 Schema reference

Full DDL lives in `scanner-plan-v1.md` §8. Required hypothesis fields:

| Field | Type | Purpose |
|---|---|---|
| `id` | text | `H-YYYY-NNN` slug |
| `name` | text | One-line human description |
| `status` | enum | proposed / scanning / testing / live / retired |
| `inefficiency_type` | enum | informational_lag / structural / behavioral / analytical / capacity / resolution_rule |
| `measured_variable` | text FK | Reference to `pmci.measured_variables` — drives signal cancellation |
| `edge_direction` | enum | bullish_yes / bearish_yes / neutral |
| `edge_magnitude_c` | numeric | Estimated edge in cents when active |
| `confidence` | numeric | 0.0–1.0; decays over time for behavioral signals |
| `applies_when` | jsonb | Preconditions that must evaluate true for activation |
| `invalidated_by` | text[] | Hypothesis IDs that veto this one when active |
| `ttl_seconds` | int | How long signal stays active after conditions first met |
| `expected_trades_per_day` | numeric | Frequency estimate (populated by strategy aggregator) |
| `expected_edge_per_trade_c` | numeric | Realized edge per trade after fees |
| `min_position_size_c` | int | Below this, fee drag kills edge |
| `max_position_size_c` | int | Per-trade capacity ceiling |
| `avg_position_hold_seconds` | int | Capital recycle rate |
| `max_concurrent_positions` | int | Capacity for parallel positions |
| `mechanism_md` | text | Plain-language explanation, ≥3 sentences |
| `source_chain_id` | uuid FK | Provenance: world_event → source → ingestion → detection |
| `entry_rules` | jsonb | When to enter (for testing/live stages) |
| `exit_rules` | jsonb | When to exit |
| `sizing_rules` | jsonb | Per-trade sizing logic |
| `risk_gates` | jsonb | Drawdown ladder, kill switch thresholds |
| `falsification_test` | text | The condition under which this hypothesis dies |
| `feature_importance` | jsonb | Auto-computed nightly via regression once ≥50 resolved rows |

---

## §4 Posture thresholds — STANDARD with strict-bumps on testing→live

Operator selected **STANDARD posture** with three strict-bumps on `testing → live` because "I want to make sure this thing works."

### 4.1 `proposed → scanning` (all four required)

| Marker | Threshold | What it prevents |
|---|---|---|
| Documentation completeness | 100% required fields populated | Ghost hypothesis with no owner |
| Source chain registered | Row exists in `pmci.source_chains` | Hypothesis pointing at a feed that hasn't been built |
| Detector emits rows | ≥1 row in 24h smoke test | "Scanning" with no actual data flow |
| Manual operator sign-off | `promoted_at` timestamp set by operator | Automation drift |

### 4.2 `scanning → testing` (all five required)

| Marker | Threshold | What it prevents |
|---|---|---|
| Resolved row count | ≥50 | Trading off statistical noise |
| Hit rate CI lower bound | >0.55 | Trading hit rate not statistically distinguishable from random |
| Mean signal after fees | >1c | Trading edges smaller than fees eat |
| Edge stability | <10pp absolute difference between first-half and second-half hit rate | Trading an already-decaying edge |
| Time elapsed | >7 days | Graduating before market regime change has been seen |

### 4.3 `testing → live` (all seven required, with strict-bumps)

| Marker | Threshold | What it prevents |
|---|---|---|
| Real trade count | ≥30 | Graduating off too few real-money samples |
| Realized PnL net of fees | **>1% of test capital** *(strict-bump from STANDARD's >$0)* | Lucky-positive PnL on small sample |
| Hit rate persistence | within 10pp of scanning hit rate | Edge that worked only in observation regime (not when traded) |
| Max drawdown during testing | **<15%** *(strict-bump from STANDARD's <20%)* | High-vol edge that's lottery-shaped |
| Realized slippage | <30% of mean signal strength | Edge killed by execution friction |
| 5-min markout | no extreme negatives on filled trades | Adverse-selection victim disguised as edge |
| Time elapsed in testing | **>21 days** *(strict-bump from STANDARD's >14)* | Graduating before market regime variation seen |

### 4.4 `live → retired` (any one triggers)

| Trigger | Source |
|---|---|
| `weighted_drift > 0.2` | Nightly Frouros PSI/KS computation, weighted by auto-computed feature importance |
| KSWIN streaming alarm | River streaming change-point on rolling hit-rate error |
| Realized portfolio drawdown ≤ -3% on this hypothesis | Live PnL track (catches bad luck not feature drift) |
| Manual override | Operator sets `retired_reason` = 'manual' |

After retirement: 30-day cool-down before re-proposal. No demotion path (`live` does not regress to `testing`).

---

## §5 Worked example — H-2026-001

The first hypothesis to be opened in v1. Walks every required field.

```yaml
id: H-2026-001
name: "NBA late-game informational lag — Kalshi mid stable >30s after high-WPA play"
status: proposed   # → scanning once detector emits rows

inefficiency_type: informational_lag
measured_variable: nba_player_team_win_probability    # FK to measured_variables
edge_direction: bullish_yes    # default; reverses based on event direction at runtime
edge_magnitude_c: 4.0
confidence: 0.65

applies_when:
  game_status: "in_progress"
  period: ">= 3"   # only 3rd quarter onward
  game_clock_seconds_remaining: "< 600"   # last 10 min of game time
  wpa_at_event_percentile_30d: "> 0.75"   # high-leverage event

invalidated_by:
  - H-2026-005    # game-over detector (settled markets exist)
  - H-2026-009    # rotator-pulled markets (orchestrator subscribed to wrong universe)

ttl_seconds: 30   # signal active 30s post-event before decay

expected_trades_per_day: 12
expected_edge_per_trade_c: 3.5
min_position_size_c: 500
max_position_size_c: 5000
avg_position_hold_seconds: 1800   # 30 min average hold
max_concurrent_positions: 3

mechanism_md: |
  Kalshi NBA markets are partly made by humans + slow MMs that don't poll cdn.nba.com.
  When a high-WPA play happens (game-changing 3pt, transition foul, end-of-period buzzer-beater),
  hoopR's live WP estimate updates within ~5s, but the Kalshi book takes 30s-5min to reprice
  depending on game state and book depth. Window of edge: take Kalshi side that's stale at
  T+30s when divergence > 3c.

  This hypothesis specifically targets late-game high-leverage moments (3rd Q onward, last 10 min)
  because (a) WPA shifts are largest then, (b) Kalshi books thin out late so any informed flow
  shifts mid more dramatically, (c) consensus retail attention is highest then so adverse
  selection cuts both ways.

source_chain_id: <uuid>
# References row in pmci.source_chains:
#   world_event = 'nba_high_wpa_play'
#   public_source = 'cdn.nba.com/static/json/liveData/playbyplay/playbyplay_{gameId}.json'
#   ingestion = 'poll_3s'
#   detection = 'wpa_p75_AND_mid_stable_30s_AND_diverge_3c'
#   version = 'v1'

entry_rules:
  - condition: "abs(fair_wp - kalshi_mid_post30) > 0.03"
    action: "log_signal"
  - condition: "applies_when.all_true AND tradable=true AND hypothesis.status='live'"
    action: "place_taker_order at side opposite to stale book"

exit_rules:
  - condition: "kalshi_book_repriced_to_within_2c_of_fair_wp"
    action: "exit at market"
  - condition: "elapsed_since_entry > 1800s"   # 30-min hard timeout
    action: "exit at market"
  - condition: "game_state == 'game_over'"
    action: "hold to settlement"

sizing_rules:
  per_trade_size_c: 500   # $5 in testing
  per_trade_size_c_live: 2500   # $25 once live (subject to allocator)
  max_concurrent_positions: 3
  scale_with_confidence: true   # signal strength × confidence

risk_gates:
  daily_loss_cap_c: 500   # $5/day during testing
  daily_loss_cap_c_live: 2500   # $25/day live
  max_drawdown_halt_c: 1500   # -$15 = halt for the day
  cooldown_after_3_same_side_fills_seconds: 600   # 10-min cool-down

falsification_test: |
  This hypothesis dies if any of:
  - average measured edge < 2c after 100 scanner observations (signal was noise)
  - hit rate CI lower bound < 0.50 over 50 actual trades (no edge in execution)
  - max drawdown exceeds 15% of test capital (vol kills it)
  - hit rate persistence drops > 15pp from scanning to testing (observation artifact, not edge)

feature_importance: null   # auto-computed once ≥50 resolved rows accumulate
feature_importance_n: 0
```

---

## §6 Decay monitor

Runs nightly. Two redundant signals so a slow-rotting source doesn't sneak past the streaming alarm and a sudden regime shift doesn't have to wait for the nightly batch.

### 6.1 Frouros PSI/KS (nightly batch)

```python
# nightly cron
for h in hypotheses where status in ('live','testing'):
    rows = pmci.scanner_<type>_signals where hypothesis_id = h.id and resolved_at is not null
    if len(rows) < 30:
        continue
    ref_window = rows[:len(rows)//2]
    cur_window = rows[len(rows)//2:]
    psi_per_feature = {col: frouros.psi(ref_window[col], cur_window[col]) for col in features}
    ks_per_feature  = {col: frouros.ks(ref_window[col], cur_window[col])  for col in features}
    importance = h.feature_importance or {col: 1.0/len(features) for col in features}  # uniform prior
    weighted_drift = sum(psi_per_feature[col] * importance[col] for col in features)
    write to pmci.hypothesis_decay_state
```

Trigger: `weighted_drift > 0.2`.

### 6.2 River KSWIN (streaming)

For each resolved row: feed `(predicted_outcome == actual_outcome)` boolean into `kswin = River.drift.KSWIN()`. When `kswin.drift_detected`, set `streaming_kswin_alarm = true` on the decay state row.

This catches sudden regime shifts (e.g., competition tightening the lag window from 30s to 3s overnight) that batch PSI would miss until the next nightly run.

### 6.3 Auto-feature-importance loop (Q7=B)

```python
# nightly cron, after PSI/KS
for h in hypotheses where status in ('live','testing'):
    resolved = rows where hypothesis_id = h.id and resolved_at is not null
    if len(resolved) < 50:
        continue   # uniform prior remains
    X = resolved[feature_columns]
    y = (resolved.resolved_outcome == 'hit').astype(int)
    coef = LogisticRegression(...).fit(X, y).coef_[0]
    importance = dict(zip(feature_columns, abs(coef)))
    pmci.hypotheses.update(h.id, feature_importance=importance, feature_importance_n=len(resolved))
```

Until 50 rows: uniform prior weights all features equally. After: regression-derived weights.

---

## §7 Weekly review ritual

Every Sunday morning, operator reviews `weekly digest` (auto-generated by Sunday cron). Three sections to act on:

1. **Promotion candidates** — hypotheses that cleared posture thresholds for `scanning → testing` or `testing → live` this week. Operator inspects each, sets `promoted_at` to advance state.
2. **Decay table** — hypotheses tripped PSI/KSWIN this week. Already auto-retired by the cron. Operator confirms or manually overrides (e.g., "this was a Kalshi outage, not a real signal change").
3. **Capital allocation summary** — portfolio allocator's weekly output. Operator can override allocations if a strategy has been performing well anecdotally but the formula is conservative.

Time budget: 30-45 minutes weekly.

---

## §8 Cross-cutting rules

These shape the system regardless of individual transitions:

- **Concurrent live cap** = `2 × (total_capital / $100)`. At $100 capital → max 2 live; at $500 → max 10. Capacity-driven, not arbitrary.
- **Concurrent testing cap** = max 3. At small capital you can't paper-trade everything realistically.
- **No demotion path.** A hypothesis that worked and stopped working is a *different* hypothesis from an untested one. Repropose with a new ID.
- **Hard kill on accumulated drawdown.** Live hypothesis hits -3% portfolio loss on its allocated capital → auto-retire even if PSI is fine. PSI catches feature drift; this catches bad luck.
- **30-day cool-down after retirement.** Don't repropose the same hypothesis (or close variants) for 30 days. Prevents the "tweak one parameter and retry" graveyard.
- **Hypothesis IDs are sequential and never reused.** `H-2026-001`, `H-2026-002`... A retired hypothesis keeps its ID forever as institutional memory.

---

## §9 Operational notes

**Where the tracker lives.** Authoritative state in `pmci.hypotheses` (DB). Markdown mirror at `~/prediction-machine/docs/strategies/active-hypotheses/H-YYYY-NNN.md` for human review and version control. The DB is canonical; markdown can drift if not kept in sync.

**Adding a new measured variable.** Insert a row in `pmci.measured_variables` first. Then reference its ID from the hypothesis's `measured_variable` field. The reference table is append-only — never edit existing rows; create new IDs if scope changes.

**Compositor netting.** Two hypotheses with the same `measured_variable` and opposite `edge_direction` cancel, not sum. Worked example:

- `H-007 player_contribution_score bullish_yes magnitude=4c`
- `H-008 player_contribution_score bearish_yes magnitude=3c`
- Net edge: `+1c` (4 - 3), not `+7c` (4 + 3)

Two hypotheses with *different* `measured_variable` are orthogonal and sum correctly:

- `H-001 nba_player_team_win_probability bullish_yes magnitude=4c`
- `H-100 maker_taker_gap_pct bullish_yes magnitude=2c`
- Net edge: `+6c`

**Conflict handling.** When `conflict_flag=true` on the compositor's `market_signals` row but net edge is still above threshold, *widen the spread* (acknowledge uncertainty), don't abstain. Quote demands more edge to compensate for the disagreement. This preserves alpha — you don't walk away from a structural edge just because a behavioral signal is muddying the picture.

---

## Appendix A: Hypothesis lifecycle audit log

Every state transition writes to a parallel audit log (separate from the schema for now; recommend adding `pmci.hypothesis_state_log` table during build). Required fields per row: `(hypothesis_id, from_status, to_status, transition_at, reason, actor)`. Enables post-hoc analysis of "what made these graduate vs retire."

## Appendix B: Reference repos

- `IFCA-Advanced-Computing/frouros` — PSI/KS implementations (decay batch)
- `online-ml/river` — KSWIN/ADWIN (decay streaming)
- `SergioWatanabe/-ATP-Prediction-Engine-Alpha-Decay-Market-Regime-Analysis` — `analyze_weighted_drift` pattern (the *idea*, not the code)
