# System State

## Legacy vs active runtime surfaces
- **Active PMCI API:** `src/api.mjs` (Fastify). Run with `npm run api:pmci` (or `npm run api:pmci:dev`). Serves `/v1/health/*`, `/v1/coverage*`, `/v1/markets/*`, `/v1/market-families`, `/v1/market-links`, `/v1/signals/*`, `/v1/review/*`, `/v1/resolve/link`.
- **Legacy API:** Root `api.mjs` (Node HTTP). Run with `npm run api` (or `npm run api:dev`). Execution-intelligence endpoints only (`/signals/top`, `/execution-decision`, `/routing-decisions/top`). Deprecated in favor of `src/api.mjs` for PMCI; this file is retained for execution-signal use until a sunset milestone. Do not add new PMCI routes here.

## Observer frontier (v2) — env reference
DB-backed pair discovery replaces mandatory large static JSON when enabled.

| Env | Meaning |
|-----|---------|
| `OBSERVER_DB_DISCOVERY=1` | Each cycle, merge capped SQL frontier from `pmci.market_links` (`lib/ingestion/observer-frontier.mjs`) |
| `OBSERVER_USE_DB_FRONTIER_ONLY=1` | Ignore static file; pairs = DB frontier only (still requires `OBSERVER_DB_DISCOVERY=1` behavior) |
| `OBSERVER_ALLOW_EMPTY_STATIC=1` | Allow `[]` in `scripts/prediction_market_event_pairs.json` when using DB merge |
| `OBSERVER_MAX_PAIRS_PER_CYCLE` | Cap DB rows per cycle (default 500) |
| `OBSERVER_CATEGORY_ALLOWLIST` | Optional comma list; both Kalshi and Poly `provider_markets.category` must match |
| `OBSERVER_INCLUDE_PROXY_LINKS=1` | Include `proxy` links in frontier (default: `equivalent` only) |
| `PMCI_SWEEP_PRIORITIZE_LINKED=1` | PMCI sweep orders stale markets so linked `provider_markets` refresh first (`lib/ingestion/pmci-sweep.mjs`) |

## Script ownership boundaries
- `api:pmci*` scripts own PMCI `/v1/*` runtime behavior.
- `api*` scripts (without `:pmci`) are legacy execution API only.
- `start` / `observe:spreads` own observer ingestion loop execution.
- `pmci:*` scripts are PMCI operational workflows (ingest/probe/smoke/review/audit/check), not API server entrypoints.

## MM MVP W1 — Kalshi L2 depth ingestion (2026-04-24)
Depth ingestion is a parallel WS stream for MM-specific data; it does NOT alter
the observer's active-only invariant on REST-polling ingestion.

| Surface | Path |
|---|---|
| Module | `lib/ingestion/depth.mjs` |
| Auth | `lib/providers/kalshi-ws-auth.mjs` (RSA-PSS; sign string `{ts}GET/trade-api/ws/v2`) |
| Schema | `supabase/migrations/20260424120004_pmci_provider_market_depth.sql` — `pmci.provider_market_depth` with `UNIQUE (provider_market_id, observed_at)` for idempotent writes |
| One-shot verification script | `scripts/ingestion/mm-depth-oneshot.mjs` (manual W1 check; not cron) |
| Fly app (proposed) | `pmci-mm-runtime` via `deploy/fly.mm.toml`; single-instance invariant (MM plan §Invariants). W1 occupant: depth only |
| Runtime env | `KALSHI_DEMO_API_KEY_ID`, `KALSHI_DEMO_PRIVATE_KEY_PATH` (or inline `KALSHI_DEMO_PRIVATE_KEY`), `KALSHI_DEMO_WS_URL` (default `wss://demo-api.kalshi.co/trade-api/ws/v2`), `KALSHI_DEMO_UNIVERSE_TICKERS` |
| Dep | `ws@^8` — added to package.json for WebSocket client |
| Downsample cadence | 1Hz, top 10 levels per side per market |
| Dependency shape | Demo environment only in W1. Production WS writes are W2+ with the trader client |

YES-ask is derived as `100 - best_no_bid` at read time — Kalshi's WS sends YES-bid
and NO-bid ladders only (both are bid sides). Column names on the depth table are
`yes_levels` / `no_levels` accordingly; the MM plan's original `bids`/`asks` names
were corrected in the 2026-04-24 W1 spec check.

---

## Current status (2026-05-03)

- **Branch / phase:** `main` at HEAD `073528b` (ADR-012 T0 captured). **PROD MM live capital, day 1 of 7 (ADR-012 clock).** T0 = 2026-05-02T22:37:20.567Z; expires 2026-05-09T22:37:20Z. The DEMO clock (ADR-008/010) was paused early at ~hour 92 of 168 with daily-loss criterion already RECORDED-FAIL on day 2 — useful plumbing data, not strategy data; superseded by ADR-012 PROD clock.
- **Production runtime (3 Fly apps):**
  - `pmci-api.fly.dev` — Fastify API + `/v1/mm/*` admin routes for runtime dashboard. Healthy.
  - `pmci-observer.fly.dev` — observer loop. **Public DNS unresolvable as of 2026-05-03 (`Could not resolve host`)**, but `pmci-api`'s `/v1/health/freshness` shows lag=66s and snapshots advancing — internal IPv6 reachability presumed intact. Investigate before next deploy.
  - `pmci-mm-runtime.fly.dev` — MM orchestrator, **single-instance invariant**, `MM_RUN_MODE=prod`. Started 2026-05-03T01:13:07.896Z (post-rotator-restart with 7 enabled rows).
- **MM live state (2026-05-03 02:42Z, ~T0+4h05m):** 7 enabled PROD markets; lifetime `mm_orders=57,113` (+7,249 vs 2026-05-02 12:17Z) / 24h=10,946 / since-T0=1,945; lifetime `mm_fills=197` (+40) / since-T0=**1**; lifetime `mm_kill_switch_events=44,377` with 24h delta = **5** (within healthy band; likely from the 30s stale-DEMO-rows window during cutover); latest `mm_pnl_snapshots.observed_at`=2026-05-03T02:40:00Z (cron healthy, 188 snapshots since T0); `mm-ingest-outcomes` cron (new ADR-011) writing — `market_outcomes=109` (+33 in 24h).
- **First PROD fill (id 197):** 2026-05-03T02:26:41Z, `KXNBA-26-OKC` yes_sell @ 57c, fair_value_at_fill 55.387c (gross spread captured ≈ +1.6c), adverse_cents_5m = −2.11c, kalshi_net_fee_cents = NULL (writer not yet wired to populate; lane-13 follow-up).
- **API freshness (2026-05-03 02:42Z):** Kalshi + Polymarket lag 66s (slightly above ideal but within healthy band; observer-DNS issue may be related); provider_markets=181,388 (+9,055); snapshots=6,595,519 (unchanged from 2026-05-02 — likely cron pause during cutover; verify on next sync); families=205 (unchanged); current_links=356 (unchanged).
- **Polymarket indexer state:** unchanged — schema + reorg state machine + read-only client namespace + CI lint guard all merged. `pmci.poly_wallet_trades=0` (W2 ingestion not yet started). `pmci-poly-indexer` Fly app not deployed.
- **Cron:** pg_cron MM stack now includes `mm-ingest-outcomes` (hourly at :07, ADR-011 cutover gate 4) on top of the existing post-fill backfill (every minute), P&L snapshot (5 min), daily ticker rotator (09:00 UTC), 24h stream heartbeat (10:00 UTC). All verified writing rows.
- **Live-MM seed v2 (lane-12 expansion 2026-05-03 01:13Z):** original pair (`KXNBA-26-OKC`, `CONTROLS-2026-D`) at 1c PROD spread + 5 wider-spread additions across diverse families — `KXMIDTERMMOV-MAGOVD-P26` (MA-gov margin, mid 42c, 4c spread), `KXWTIMAX-26DEC31-T135` (WTI ≥$135, mid 46c, 6c spread), `GOVPARTYAZ-26-D` (AZ-gov-D, mid 74c, 4c spread), `KXETHMINY-27JAN01-1250` (ETH ≤$1250, mid 36c, 4c spread), `KXLCPIMAXYOY-27-P4.5` (CPI YoY ≥4.5%, mid 60c, 4c spread, HPL depth-capped to 9 — option (i) per operator). All seeded via direct UPSERT bypassing rotator's `validateTickerForMM` after lane-12 fresh re-probe; future daily-rotator runs will use the rotator path with `MM_RUN_MODE=prod`.
- **Ops:** `npm run pmci:status` for API health + smoke counts. `curl -sS https://pmci-mm-runtime.fly.dev/health/mm` for MM runtime status. `curl -sS -H "X-PMCI-API-KEY: $PMCI_API_KEY" https://pmci-api.fly.dev/v1/mm/{markets,orders,positions,pnl,fills,kill-switch-events}` for runtime dashboard.

### Drift from ADR-008 (captured retroactively in ADR-010, 2026-05-01) — historical

ADR-008 specified "5 hand-curated demo markets continuously quoted for 7 days." The actual test design as of 2026-04-30 included 8 markets + daily rotator + 24h heartbeat verifier. Then on 2026-05-02 the DEMO clock was paused early (per ADR-012) when the operator pivoted to PROD live capital. Both ADR-008 and ADR-010 are now superseded for active operations by ADR-012; preserved for historical audit context.

### Open work (post 2026-05-02 cutover)

- **PROD 7-day clock (ADR-012)** running — verdict at hour 168 (2026-05-09T22:37Z) recorded in ADR-013 (TBD). Per-criterion: continuous quoting on ≥1 market, net positive P&L net-of-fees, ≤1 auto-flatten, zero `daily_loss_limit_cents=500` breach, legible per-market R7 attribution, lane-13 fee-statement reconciliation ≤2% variance.
- **Rotator universe-endpoint fix (operator-owned, due tonight 2026-05-03):** the rotator's `selectMarketsForRotation` queries `/markets?status=open` which returns mostly KXMVE* parlay junk (lane-12 finding); needs to switch to `/events?with_nested_markets=true`. Next rotator fire is 2026-05-03T09:00 UTC. If fix lands before then via `pmci-api` redeploy, rotator runs against the corrected universe; otherwise it most likely no-ops (no candidates pass validation), and our manual seed survives.
- **`mm_fills.kalshi_*_fee_cents` writer wiring (lane-13 follow-up):** columns exist (2026-05-02 migration) but the fill ingest path doesn't populate them yet. Required for live fee reconciliation against Kalshi monthly statement.
- **Track B residual (deferred):** migration-secrets rotation (anon JWT + PMCI_API_KEY in two old migrations) is intentionally deferred until the PROD 7-day clock closes — see `track-b-rotate-migration-secrets`.
- **Indexer W2 (Polymarket on-chain ingestion):** unchanged; remains next workstream once the MM clock closes.

### Known risks (2026-05-03)

- **Fill ratio anomaly (sub-threshold):** since-T0 fill ratio = 1/1945 = 0.05%, below the 0.1% anomaly floor in the `/update` skill spec. Expected for the 5/7 markets at 1c PROD spread where 2c-half puts us 1c outside the inside book; the 5 wider-spread additions seeded at 01:13Z should lift the ratio over the next 24h. Re-evaluate at 2026-05-03T22:37Z (T+24h).
- **WS depth staleness on low-vol PROD tickers:** `KXETHMINY-27JAN01-1250` (255s) and `KXLCPIMAXYOY-27-P4.5` (164s) trip Track J's 30s threshold consistently — informational, not actionable. Per-ticker threshold tuning is a future option.
- **Observer DNS unresolvable:** `pmci-observer.fly.dev` doesn't resolve publicly; machine is `started` per `fly status`. Snapshots are still landing per `pmci-api` freshness, but verification path is broken. Investigate during the next sync.
- **`provider_market_snapshots` count unchanged 6,595,519** since 2026-05-02 12:17Z snapshot — possible observer pause during cutover OR reporting artifact (snapshot retention may have offset new inserts). Verify with a per-day count query on next sync.
- **44,377 `mm_kill_switch_events` cumulative** (was 44,372) — +5 in 24h, all attributable to the cutover-window stale-DEMO-rows incident (no fresh kill-switch fires on the 7 PROD-mode rows). RECORDED-FAIL on the DEMO daily-loss criterion stands; not relevant to ADR-012 PROD clock.
- **Untracked `scripts/hooks/`** in working tree on `main` — operator's local pre-deploy hook scripts. Expected; not committed by design.
- **HA-pair invariant:** Fly's default deploy strategy creates a 2-machine HA pair on first PROD deploy, violating MM single-instance invariant. Mitigation in place: subsequent deploys use `--ha=false`; manual `fly scale count 1 --yes` after any deploy that creates extras. Document in MM runtime runbook.
- Freshness thresholds differ between CLI and API by design; align operator expectations via `PMCI_MAX_LAG_SECONDS` / API config.

### Carry-forward
- Canonical event lifecycle after settlement (archive vs delete) — ADR pending.
- Production cutover from Kalshi DEMO to live Kalshi after 7-day validation closes — gated on validation outcome, kill_switch investigation, and a separate ADR. With daily-loss already FAILED on day 2, the cutover ADR will need to either re-spec the exit criteria or document accepting the failure mode in production.
- Migration-secrets rotation (two old migrations contain anon JWT + PMCI_API_KEY) — deferred until 7-day clock closes.

---

## Historical detail

Older dated snapshots, sprint tables, and phase-by-phase closeouts were removed from this file to reduce drift. Use git history for prior `system-state.md` content if you need a specific dated snapshot.
