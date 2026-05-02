---
title: Depth staleness watchdog audit (2026-05-02)
status: final
last-verified: 2026-05-02
trigger: Cursor prompt 03 — Lane A4 / Track J verification vs KXHIGHTBOS depth gap narrative
sources:
  - lib/ingestion/depth.mjs
  - lib/mm/runtime-health-payload.mjs
  - pmci-mm-runtime /health/mm (live curl)
  - Supabase SQL — enabled markets × provider_market_depth
---

## Verdict

**PASS** — The Track J per-book staleness watchdog is implemented in the depth WebSocket runtime, and `/health/mm` surfaces stale tickers and per-ticker ages. At audit time, live health showed `depthTickersStale: []` and all eight enabled markets had comparable depth row volume in the last hour; the prompt-specific ticker `KXHIGHTBOS-26MAY01-T61` (market_id 4468379) **does not appear** in the current enabled set (likely rotated out by the daily rotator).

## Evidence

### Where the watchdog lives

- **Per-ticker age** is computed in `secondsSinceLastUpdate` (book `lastUpdateMs`, `Infinity` when missing or no active ingestion) — ```76:81:lib/ingestion/depth.mjs```.
- **Layer 2 majority-stale reconnect:** every **30s**, if the socket is open, it counts tickers with `secondsSinceLastUpdate > STALE_QUOTE_SEC * 2` where `STALE_QUOTE_SEC = 60` (i.e. **>120s** without an update). If **>50%** of subscribed tickers are stale, it logs `depth.watchdog.force_reconnect` and schedules reconnect — ```474:495:lib/ingestion/depth.mjs```.
- **WS application heartbeat:** `ws.ping()` every **25s** while open — ```453:465:lib/ingestion/depth.mjs```.

### Health payload wiring

- `getHealthSnapshot()` builds `depthLastUpdateSecondsAgo` (per ticker) and `depthTickersStale` when `!connected || raw === Infinity || sec > STALE_QUOTE_SEC` (**60s** threshold for the health list, stricter than the 120s majority watchdog) — ```656:677:lib/ingestion/depth.mjs```.
- `buildMmHealthMmResponse` folds that into `/health/mm`, sets `ready` false when `depthTickersStale` is non-empty — ```15:27:lib/mm/runtime-health-payload.mjs```.

### Live `/health/mm` (2026-05-02, curl)

`curl -sS https://pmci-mm-runtime.fly.dev/health/mm` returned (abridged):

- `depthSubscribedConfigured`: 8, `depthSubscribedConnected`: 8  
- `depthTickersStale`: **[]**  
- `depthLastUpdateSecondsAgo`: eight tickers with ages **6–58s** (all under the 60s stale flag in code)  
- `ready`: true, `severity`: "none"

Full JSON line preserved in operator notes if needed; stale array was empty.

### SQL — depth rows by enabled market

Query (prompt Lane A4 shape) against production DB:

- All **8** enabled markets showed **rows_1h ≈ 3545–3557** and recent `latest observed_at` (~same second across markets). **No** `rows_1h = 0` row.
- **KXHIGHTBOS** / market **4468379** did not appear in the `mm_market_config.enabled = true` result set.

## Proposed action

- **No code change required on this branch** for the watchdog: it is wired; alerts are **structured logs** (`depth.watchdog.force_reconnect`) plus **HTTP health** (`depthTickersStale`, `depthLastUpdateSecondsAgo`). If an operator wants paging, attach log/metrics sinks to those fields—out of scope here.
- If a market shows **0 depth rows** in DB again: confirm it is still `enabled`, confirm WS subscribe succeeded for that ticker (burst-spacing / Kalshi-side gaps), and compare `depthLastUpdateSecondsAgo[ticker]` on `/health/mm` to the **60s** health threshold vs **120s** majority reconnect threshold.

## Recommendation

Treat **DB depth row counts** and **`/health/mm.depthTickersStale`** as the joint source of truth: when a ticker stops updating in-process, it should land in `depthTickersStale` within a minute; whether a single dead ticker among eight trips **readiness** depends on `runtime-health-payload` (empty stale list still required for `ready=true`). Continue to rely on Fly logs for `depth.watchdog.force_reconnect` when >50% of books go quiet.
