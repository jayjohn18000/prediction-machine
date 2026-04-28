# Observer pair-failure alert (Pre-W6)

Synthetic guardrail surfaced on **`GET /v1/health/observer`** in `true_success_rate`. It summarizes **Σ `pairs_attempted`**, **Σ `pairs_succeeded`**, and **`pairs_failed`** from **`pmci.observer_heartbeats`** over the last **30 minutes** (same truth table PostgREST uses for lag). **`alert`** is **`true`** when aggregate **`failure_rate = pairs_failed / pairs_attempted` > 0.10**.

## Meaning

Cross-venue spreads only close when BOTH Kalshi and Polymarket prices exist for each configured pair row. Chronic partial failure (typically ~17/91 polymarket legs per cycle) inflates ingestion noise and poisons downstream fair-value workflows that silently blend unmatched pairs (see MM W3 linkage after `v_polymarket_latest_prices` rollout).

## Reading the endpoint

```bash
curl -sS "${PMCI_PUBLIC:-http://localhost:8787}/v1/health/observer?provider=polymarket" | jq '.true_success_rate'
```

- **`by_provider`** splits Σ failure mass using summed Kalshi/Polymarket fetch-event counters + spread-insert errors (**heuristic** — heartbeat rows omit per-leg pair attribution). Expect **Kalshi `failure_rate` ≈ 0** unless Kalshi outages dominate; Poly chronic issues push **`polymarket.failure_rate`** toward the headline aggregate (~0.15–0.22 in current prod posture).
- **`provider_focus`** echoes the keyed leg when **`?provider=`** filters.

## Investigation checklist

| Symptom | Likely bucket | Actions |
|---------|-----------------|--------|
| High `failure_rate`, low `kalshi.failure_rate.fetch_error_events_sum` | Polymarket price/map staleness (`polymarket_yes invalid` logs) | Check `observer` stderr for **`Price sanity`** lines; rerun targeted slug via `lib/providers/polymarket.mjs` fetch helpers. Agent 01 §**G4** documents **single Gamma base**, **no multi-base failover**, **retry-twice hard cap** → transient outages surface here. |
| `kalshi.failure_rate.fetch_error_events_sum` climbs | Kalshi batch outage (`kalshi_fetch_errors` incremented pre-loop) | Check Kalshi status & rate-limit (`HTTP 429` log lines before pair loop). |
| `spread_insert_errors` dominates | Persistence path | Inspect Supabase `prediction_market_spreads` rejects / RLS. |

## Operational notes

- No Slack pager yet — **`alert`** is informational until escalation wiring lands.
- **Do not silence** via lowering threshold without acknowledging MM fair-value ingestion requirements.
- For forensic deep dives correlate heartbeat rows with **`pmci.observer_heartbeats.cycle_at`** vs structured logs archived off-host.
