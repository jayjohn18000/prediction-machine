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

## Current status (2026-05-01)

- **Branch / phase:** `main` (merged Track F / ops branches 2026-05-01; push to `origin/main` up to deploy). **MM MVP 7-day validation in progress, day 3 of 7.** Clock started 2026-04-28T17:41:28.638Z (ADR-008); window expires ~2026-05-05T17:41Z. **Polymarket on-chain wallet indexer Pre-W1 + W1 shipped** 2026-04-28 (ADR-009; commit `2ab3160`).
- **Production runtime (3 Fly apps):**
  - `pmci-api.fly.dev` — Fastify API + `/v1/mm/*` admin routes for runtime dashboard
  - `pmci-observer.fly.dev` — observer loop (Kalshi + Polymarket REST + Kalshi WS depth)
  - `pmci-mm-runtime.fly.dev` — MM orchestrator, **single-instance invariant**, `/health/mm` endpoint, W4 reconcile phase
- **MM live state (2026-05-01 ~14:36Z):** 8 enabled demo markets (drift from ADR-008's static 5 — see "Drift from ADR-008" below); ~45,582 mm_orders; 118 mm_fills; **44,372 mm_kill_switch_events** (suspiciously high, investigate before production cutover); latest mm_pnl_snapshot from <1 min ago; 8/8 depth subscriptions connected; depth ticker staleness 160–273s (likely normal for demo low-activity markets).
- **API freshness (2026-05-01 ~14:36Z):** Kalshi + Polymarket lag 30s; provider_markets=161,083; snapshots=6,095,067; families=205; current_links=356.
- **Polymarket indexer state:** schema + reorg state machine + read-only client namespace + CI lint guard all merged. `pmci.poly_wallet_trades` count = 0 (W2 ingestion process not yet started). `pmci-poly-indexer` Fly app not deployed.
- **Cron:** pg_cron now includes the MM stack (depth pruning daily, post-fill backfill every minute, P&L snapshot every 5 min, daily ticker rotator, 24h stream heartbeat) plus the legacy ingest/audit/review crons. Job runner via Supabase `pmci-job-runner` Edge Function.
- **Ops:** `npm run pmci:status` for API health + smoke counts. `curl -sS https://pmci-mm-runtime.fly.dev/health/mm` for MM runtime status. `curl -sS -H "X-PMCI-API-KEY: $PMCI_API_KEY" https://pmci-api.fly.dev/v1/mm/{markets,orders,positions,pnl,fills,kill-switch-events}` for runtime dashboard.

### Drift from ADR-008 (captured retroactively in ADR-010, 2026-05-01)
ADR-008 specified "5 hand-curated demo markets continuously quoted for 7 days." The actual test design as of 2026-04-30 includes 8 markets enabled at any time PLUS a daily ticker rotator (`scripts/mm/rotate-demo-tickers.mjs` + cron migration `20260430140000_pmci_mm_rotator_cron.sql`) PLUS a 24h stream-heartbeat verifier (`scripts/mm/mm-stream-heartbeat.mjs`). The exit-criterion semantics changed from "5 markets continuous" to a rotating set. ADR-010 documents this drift; an open question (Track D Q10) asks whether ADR-010 should stand or whether ADR-008 should be revised in place to remove the two-ADR tension.

### Open work (post Track G 2026-05-01)
- **Track B — remaining:** `pmci.unmatched_markets` / `link_gold_labels` / `linker_runs` / `linker_run_metrics` **not** dropped — `linker_runs` had 140 rows at pre-drop check (B.3 blocked). **Migration-secrets rotation** deferred by operator until the 7-day clock closes (`track-b-rotate-migration-secrets`). `pmci.proposed_links` truncate migration is in-repo (`20260501123000_pmci_truncate_proposed_links.sql`) but was **not** applied on this track (only B.3 + post-api pg_cron unschedule were in scope for DB apply).
- **Track C — MM v2 prep:** landed under `docs/plans/mm-v2/` (merge from `track-c-mm-v2-prep`).
- **Track D — open decisions:** `docs/plans/2026-05-01-open-decisions-for-jay.md` (8 questions; blanks intentional).
- **Indexer W2:** `pmci-poly-indexer` Fly app design + deployment + live-tail Polygon RPC ingestion all unstarted.

### Known risks (2026-05-01)
- **Runtime redeployed 2026-05-01 ~18:34Z with Track F fixes** — `lastStartupReconcileAt` field added (alias of legacy `lastReconcileAt`); `/health/mm` exposes new `ready` and `severity` fields; PnL rollup now sums latest snapshot per market; `mm_orders.status` lifecycle patched (backfill applied: 121 parent rows synced from `mm_fills`). Daily-loss exit criterion remains breached on day 2 (controlled-failure observation).
- **44k mm_kill_switch_events** all reason=`daily_loss`, fired 2026-04-29T17:09Z → 2026-04-30T13:43Z (then stopped). PnL at trip = −2,341.66 cents vs `daily_loss_limit_cents=2000`. **The 7-day run already breached the daily-loss exit criterion on day 2.** Operator decision (2026-05-01): accept as a controlled-failure observation; use the data; do not declare PASS at hour 168 on this dimension.
- **Unannounced `pmci-mm-runtime` restart 2026-04-30T19:03:22Z** (historical). Post–Track F deploy, watch `/health/mm` for `ready`, `severity`, and main-loop tick/reconcile fields — **2026-05-01 ~18:35Z check:** `ok=true` but `ready=false`, `severity=crit`, `loopTick=0`, `lastStartupReconcileAt=null` while depth remained 8/8 connected (orchestrator warm-up or startup fault; Track E should re-triage after the new health surface).
- **Daily ticker rotator** changes the test design from ADR-008; ADR-010 captures this. Open question (Track D Q10) is whether to keep both ADRs or revise ADR-008 in place.
- Depth ticker staleness on every ticker (160–273s); acceptable for demo but won't be acceptable on production where active book updates should arrive sub-second. (Note: 2026-05-01 ~15:33Z showed `depthSubscribedConnected=0/8` for ~22 minutes; recovered to 8/8 by 15:55Z. Transient WS reconnect window — Track E should investigate why the runtime didn't surface this in `/health/mm` as anything other than "ok=true" while it lasted.)
- Freshness thresholds differ between CLI and API by design; align operator expectations via `PMCI_MAX_LAG_SECONDS` / API config.

### Carry-forward
- Canonical event lifecycle after settlement (archive vs delete) — ADR pending.
- Production cutover from Kalshi DEMO to live Kalshi after 7-day validation closes — gated on validation outcome, kill_switch investigation, and a separate ADR.

---

## Historical detail

Older dated snapshots, sprint tables, and phase-by-phase closeouts were removed from this file to reduce drift. Use git history for prior `system-state.md` content if you need a specific dated snapshot.
