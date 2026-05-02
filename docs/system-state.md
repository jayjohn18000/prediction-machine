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

## Current status (2026-05-02)

- **Branch / phase:** `main` at HEAD `1777db1` (Track J Layer 2 watchdog merge). **MM MVP 7-day validation in progress, day 4 of 7** (~hour 91 of 168). Clock started 2026-04-28T17:41:28.638Z (ADR-008); window expires ~2026-05-05T17:41Z. **Polymarket on-chain wallet indexer Pre-W1 + W1 shipped** 2026-04-28 (ADR-009; commit `2ab3160`).
- **Production runtime (3 Fly apps):**
  - `pmci-api.fly.dev` — Fastify API + `/v1/mm/*` admin routes for runtime dashboard
  - `pmci-observer.fly.dev` — observer loop (Kalshi + Polymarket REST + Kalshi WS depth) — `/health` probe returned empty in today's sync; not a hard-down signal but worth re-probing if cron/freshness drift
  - `pmci-mm-runtime.fly.dev` — MM orchestrator, **single-instance invariant**, `/health/mm` endpoint, W4 reconcile phase
- **MM live state (2026-05-02 ~12:17Z):** 8 enabled demo markets (rotator-managed); lifetime `mm_orders=49,864` (+4,282 vs 2026-05-01) / 24h=4,511 / 1h=16 (1h sample taken during the post-restart warm-up); lifetime `mm_fills=157` (+39) / 24h=42 (~0.93% of orders); cumulative `mm_kill_switch_events=44,372` with **24h delta=0** (storm stopped 2026-04-30T13:43Z and has stayed stopped); latest `mm_pnl_snapshots.observed_at`=2026-05-02T12:15:02Z (cron healthy, 2,304 snapshots in 24h); `mm_orders.status='filled'` count=127 (Track F.4 backfill landed — was 0 on 2026-05-01); `pmci-mm-runtime` restarted 2026-05-02T12:17:09Z (likely Track J redeploy) — at T+2min reported `ok=true`, `ready=false`, `severity=warn`, `loopTick=22`, depth 8/8 connected, reconcile advancing (warm-up nominal — Track F readiness fields working as intended).
- **API freshness (2026-05-02 ~12:17Z):** Kalshi + Polymarket lag 24–50s; provider_markets=172,333 (+11,250); snapshots=6,595,519 (+500,452); families=205 (unchanged); current_links=356 (unchanged).
- **Polymarket indexer state:** schema + reorg state machine + read-only client namespace + CI lint guard all merged. `pmci.poly_wallet_trades` count = 0 (W2 ingestion process not yet started). `pmci-poly-indexer` Fly app not deployed.
- **Cron:** pg_cron now includes the MM stack (depth pruning daily, post-fill backfill every minute, P&L snapshot every 5 min, daily ticker rotator, 24h stream heartbeat) plus the legacy ingest/audit/review crons. Job runner via Supabase `pmci-job-runner` Edge Function.
- **Ops:** `npm run pmci:status` for API health + smoke counts. `curl -sS https://pmci-mm-runtime.fly.dev/health/mm` for MM runtime status. `curl -sS -H "X-PMCI-API-KEY: $PMCI_API_KEY" https://pmci-api.fly.dev/v1/mm/{markets,orders,positions,pnl,fills,kill-switch-events}` for runtime dashboard.

### Drift from ADR-008 (captured retroactively in ADR-010, 2026-05-01)
ADR-008 specified "5 hand-curated demo markets continuously quoted for 7 days." The actual test design as of 2026-04-30 includes 8 markets enabled at any time PLUS a daily ticker rotator (`scripts/mm/rotate-demo-tickers.mjs` + cron migration `20260430140000_pmci_mm_rotator_cron.sql`) PLUS a 24h stream-heartbeat verifier (`scripts/mm/mm-stream-heartbeat.mjs`). The exit-criterion semantics changed from "5 markets continuous" to a rotating set. ADR-010 documents this drift; an open question (Track D Q10) asks whether ADR-010 should stand or whether ADR-008 should be revised in place to remove the two-ADR tension.

### Open work (post Tracks B/C/D/E/F/H/I/J — 2026-05-02)
- **Tracks B / C / D / E / F / H / I / J shipped** 2026-05-01 → 2026-05-02. The 2026-05-01 master prompt's open work has all landed (B = arb sunset cleanup B.1–B.8; C = MM v2 prep docs at `docs/plans/mm-v2/`; D = open-decisions Q1–Q8 with operator answers; E = runtime triage memo; F = MM runtime fixes F.1–F.5; H = reconcile-timeout hotfix; I = Kalshi DEMO WS spaced subscribes; J = WS heartbeat + per-ticker staleness watchdog).
- **Track B residual (deferred until clock closes):** migration-secrets rotation (anon JWT + PMCI_API_KEY in two old migrations) is intentionally deferred by operator until the 7-day clock closes — see `track-b-rotate-migration-secrets`.
- **Indexer W2 (Polymarket on-chain ingestion):** `pmci-poly-indexer` Fly app design + deployment + live-tail Polygon RPC ingestion all unstarted. Becomes the next workstream once the MM clock closes.
- **Post-W6 audit / production cutover:** gated on hour-168 verdict (~2026-05-05T17:41Z). Daily-loss criterion is already a documented FAIL on day 2; cutover decision needs to address that explicitly in a new ADR.

### Known risks (2026-05-02)
- **`pmci-mm-runtime` restart at 2026-05-02T12:17:09Z** — coincided with Track J merge (likely deploy event). Post-restart `/health/mm` showed expected warm-up profile: `severity=crit` at T+0 (`loopTick=0`, depth `0/8`), recovering to `severity=warn` at T+2min (`loopTick=22`, depth `8/8`, reconcile advancing). Track F's readiness fields are working as designed — the `ok=true` field alone would have hidden the warm-up window. Watch for steady-state `severity=info` / `ready=true` at the next probe.
- **Untracked `scripts/hooks/`** in working tree on `main` — operator's local pre-deploy hook scripts (write-protect, single-instance check, post-migration verify-schema, etc.). Expected; not committed by design.
- **44k `mm_kill_switch_events` cumulative** — all `reason=daily_loss`, fired 2026-04-29T17:09Z → 2026-04-30T13:43Z, then stopped. 24h delta has been 0 for 48h. PnL at trip = −2,341.66 cents vs `daily_loss_limit_cents=2000`. The 7-day run **already breached the daily-loss exit criterion on day 2.** Operator decision (2026-05-01): accept as a controlled-failure observation; use the data; do not declare PASS at hour 168 on this dimension.
- **Daily ticker rotator** changes the test design from ADR-008; ADR-010 captures this. Open question (Track D Q10) is whether to keep both ADRs or revise ADR-008 in place — operator answers landed on Track D for Q1–Q8; Q10 still open.
- **Depth ticker staleness** — 5/8 tickers showed 138–141s since last update (2026-05-02 12:19Z), likely normal for demo low-activity markets. The Track J per-ticker watchdog now forces reconnect when this exceeds threshold; behavior in steady-state should be observed over the next 24h.
- Freshness thresholds differ between CLI and API by design; align operator expectations via `PMCI_MAX_LAG_SECONDS` / API config.

### Carry-forward
- Canonical event lifecycle after settlement (archive vs delete) — ADR pending.
- Production cutover from Kalshi DEMO to live Kalshi after 7-day validation closes — gated on validation outcome, kill_switch investigation, and a separate ADR. With daily-loss already FAILED on day 2, the cutover ADR will need to either re-spec the exit criteria or document accepting the failure mode in production.
- Migration-secrets rotation (two old migrations contain anon JWT + PMCI_API_KEY) — deferred until 7-day clock closes.

---

## Historical detail

Older dated snapshots, sprint tables, and phase-by-phase closeouts were removed from this file to reduce drift. Use git history for prior `system-state.md` content if you need a specific dated snapshot.
