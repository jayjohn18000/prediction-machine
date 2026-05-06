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

## Current status (2026-05-06, hour 90 of ADR-012 clock)

- **Branch / phase:** `main` at HEAD `de5fbc3` (Track M + rotator-quality merge wave). **PROD MM live capital, day 4 of 7 (ADR-012 clock).** T0 = 2026-05-02T22:37:20.567Z; expires 2026-05-09T22:37:20Z. ~hour 90 of 168 elapsed (53.5% complete). **ADR-013 Accepted 2026-05-06:** ADR-012 criterion #1 reframed to "system uptime ≥90% across rolling 30-min windows." **This clock is RECORDED-FAIL on the reframed criterion** (live uptime 46.41%; 97 of 181 windows dormant; mathematically unrecoverable since hour 90). Verdict ADR moved to ADR-014 (TBD 2026-05-09T22:37Z).
- **Production runtime (3 Fly apps):**
  - `pmci-api.fly.dev` — Fastify API + `/v1/mm/*` admin routes. ✅ Healthy (lag=11s, status=ok).
  - `pmci-observer.fly.dev` — observer loop. **Public DNS still unresolvable** (same as 2026-05-03→05), but `provider_market_snapshots=9,070,901` (+359k vs 2026-05-05 sync) so internal ingestion path is healthy.
  - `pmci-mm-runtime.fly.dev` — MM orchestrator, single-instance invariant, `MM_RUN_MODE=prod`. **Restarted at 2026-05-06T14:48:09Z (operator-driven)** to rebuild depth subscription set after yesterday's frozen-subs incident. `loopTick=1052`, `severity=warn`, `ready=false`, `depthSubscribedConnected=8/8` ✓.
- **Quoting RESUMED today.** First post-restart order at 14:20:50Z (a rotator pre-MLB cycle had repopulated `mm_market_config.enabled` rows ~28 min before the runtime restart finished depth-subscription rebuild). Last order 16:22:08Z, last fill 16:15:54Z, both live as of status check.
- **Yesterday's gap was actually 35h, not 11h.** Hour-bucket query confirms zero orders 2026-05-05 03:00Z → 2026-05-06 14:00Z. The 2026-05-05 14:50Z status snapshot read this as ~11h; live evidence shows the system stayed dormant another full day until operator restart.
- **MM live state (2026-05-06 16:30Z, ~T0+90h):** lifetime `mm_orders=61,704` (+148 vs yesterday) / 24h=148 / 6h=148 / 1h=40 / 15m=4; lifetime `mm_fills=449` (+24) / 24h=24 / 6h=24 / 1h=6; lifetime `mm_kill_switch_events=44,427` (unchanged — **24h delta=0**, since-T0=50 all on the auto-blocklisted KXMLBSPREAD); `mm_pnl_snapshots` writing every 5 min, latest snapshot 16:30:01Z. **Net PnL since T0 (sum of latest-per-market across 31 markets) = −89.0c** (spread_capture +327.8, adverse −157.1, inv_drift −15.7, fees −244.0). 24h fill rate = 24/148 = **16.2%** (up from yesterday's 8.7%, well inside healthy band).
- **24h order distribution:** 6 distinct markets quoted post-restart: `6381175` (54 orders, 9 filled), `6381174` (40, 6), `5142241` (20, 0), `6381176` (18, 6), `5010394` (8, 3), `5875133` (8, 0). Currently-enabled set in `mm_market_config` rotated to 2 new markets (`6990675`, `6990676`) at 16:00Z and they have not yet seen orders post-cycle (one-tick lag expected).
- **Cron:** ✅ all 21 PMCI cron jobs ran 24h with **0 failures**. `pmci-mm-pnl-snapshot` 288/288, `pmci-mm-post-fill-backfill` 1440/1440, `pmci-mm-rotator-disable-watcher` 288/288, `pmci-mm-rotate-tickers-pre-mlb` fired at 16:00Z. Auto-blocklist working (KXMLBSPREAD blocked 02:50Z 2026-05-05, expires 2026-05-07 03:10Z; KXLCPIMAXYOY blocked 2026-05-04, expires 2026-05-11).
- **API freshness (2026-05-06 16:28Z):** Kalshi + Polymarket lag = **11s** (healthy band, well under 300s). `provider_markets=233,987` (+21,277 vs 2026-05-05); `snapshots=9,070,901` (+359k); `families=205` (unchanged); `current_links=356` (unchanged).
- **Polymarket indexer state:** unchanged — schema + reorg state machine + read-only client namespace + CI lint guard all merged. `pmci.poly_wallet_trades=0` (W2 ingestion not yet started).
- **Today's rotator universe (rotator-managed, depth-subscribed):** `KXNHLSERIES-26MINCOLR2-MIN`, `KXNBAGAME-26MAY08SASMIN-SAS`, `KXMLBTOTAL-26MAY041940CINCHC-10`, `KXPGATOUR-ONMBC26-BHOR`, `KXMETGALA-26-DUA`, 3× BTC monthly. `enabledMarketsCount=2` post-16:00Z rotation. Notes still read `mode=demo` on PROD-running rows (cosmetic regression).
- **Ops:** `npm run pmci:status` for API health + smoke counts. `curl -sS https://pmci-mm-runtime.fly.dev/health/mm` for MM runtime status. `curl -sS -H "X-PMCI-API-KEY: $PMCI_API_KEY" https://pmci-api.fly.dev/v1/mm/{markets,orders,positions,pnl,fills,kill-switch-events}` for runtime dashboard.

### Drift from ADR-008 (captured retroactively in ADR-010, 2026-05-01) — historical

ADR-008 specified "5 hand-curated demo markets continuously quoted for 7 days." The actual test design as of 2026-04-30 included 8 markets + daily rotator + 24h heartbeat verifier. Then on 2026-05-02 the DEMO clock was paused early (per ADR-012) when the operator pivoted to PROD live capital. Both ADR-008 and ADR-010 are now superseded for active operations by ADR-012; preserved for historical audit context.

### Open work (post 2026-05-02 cutover)

- **PROD 7-day clock (ADR-012)** running — verdict at hour 168 (2026-05-09T22:37Z) recorded in ADR-014 (TBD; ADR-013 was reassigned to the criterion-reframe decision). Per-criterion at hour 90 using ADR-013-reframed criteria: system uptime ≥90% / 30-min windows = **RECORDED-FAIL** (46.41% live, mathematically unrecoverable; 34.5h dominant gap on day 3); net positive PnL = MARGINAL FAIL (cumulative −89.0c); ≤1 auto-flatten = AT-RISK (50 events since T0, 0 in last 24h); zero `daily_loss_limit_cents=500` breach = PASS; per-market R7 attribution = PASS; lane-13 fee reconciliation = PENDING.
- **Runtime depth-sub rebuild on universe change** (P0 follow-up): the 35h dormancy was caused by the orchestrator never refreshing its depth subscription set when the rotator + auto-blocklist swapped enabled markets mid-run. Operator restart at 2026-05-06T14:48Z was required as the manual unblock. Fix: on each main-loop tick, diff `mm_market_config WHERE enabled=true` against the active depth subscriber set and reconcile. Tracked for post-clock implementation; until then, document operator-restart as the unblock pattern when `depthSubscribedConfigured ≠ enabledMarketsCount`.
- **`mm_fills.kalshi_*_fee_cents` writer wiring (lane-13 follow-up):** columns exist; Track M (`fe38286`) wired the writer. Verify population on next fills (24 fills landed today post-restart; check `kalshi_net_fee_cents` populated on those before claiming fee-writer is fully proven).
- **Worst-trade alarm (Track M):** merged in `fe38286`. Watch for first alarm fire on a post-restart fill.
- **Cosmetic: rotator notes string** still hardcodes `mode=demo` while runtime is PROD. 1-line patch in the rotator config-write path.
- **Track B residual (deferred):** migration-secrets rotation (anon JWT + PMCI_API_KEY in two old migrations) is intentionally deferred until the PROD 7-day clock closes — see `track-b-rotate-migration-secrets`.
- **Indexer W2 (Polymarket on-chain ingestion):** unchanged; remains next workstream once the MM clock closes.

### Known risks (2026-05-06)

- 🟡 **Uptime criterion (ADR-013) is RECORDED-FAIL on this clock.** Live uptime = 46.41% (84/181 windows active); 90% bar already mathematically unreachable. ADR-013 (Accepted 2026-05-06) reframes ADR-012 criterion #1 to "system uptime ≥90% across rolling 30-min windows" and explicitly accepts the fail-on-this-clock parallel to ADR-011's daily-loss precedent. No mid-clock action — clock continues to T+168h to gather data on the four other criteria. Hour-168 verdict in ADR-014.
- 🟢 **Auto-blocklist + reject-rate watcher functioning correctly:** zero killswitch events in the last 24h. `KXMLBSPREAD-26MAY042138CWSLAA-CWS7` blocked at 02:50Z 2026-05-05 for `high_reject_rate` (60/81 reported as auto-blocklist; original storm was 314/404 = 77.7%); expires 2026-05-07T03:10Z. `KXLCPIMAXYOY-27-P4.5` still blocked from 2026-05-04 (`encoding_bug`, expires 2026-05-11). No action needed.
- 🔴 **Structural runtime bug — depth-sub set frozen at startup.** When the rotator + auto-blocklist change `mm_market_config.enabled` mid-run, the orchestrator's WS depth subscription set is not rebuilt. Yesterday's incident: 1 ticker subscribed at startup, that ticker auto-blocklisted, orchestrator continued running with 0 viable depth feeds for 35h until manual restart. Mitigation today is operator-restart on `depthSubscribedConfigured ≠ enabledMarketsCount`. Fix is post-clock: per-tick reconciliation in `lib/mm/orchestrator.mjs` and/or admin endpoint to trigger depth-sub rebuild without process restart. **This is the highest-leverage post-clock engineering fix.**
- **Cosmetic: rotator notes read `mode=demo` on PROD-running config rows.** Both currently-enabled rows still carry `notes: "rotator-managed mode=demo …"` even with `kalshiEnv.runMode=prod`. M.5 in `de5fbc3` resolved the mode lookup but the notes string template wasn't updated. Cosmetic only.
- **Observer DNS unresolvable** (carry-forward from 2026-05-03/04/05): `pmci-observer.fly.dev` doesn't resolve publicly. Snapshots advanced +359k since 2026-05-05 sync, so the work is happening — but the verification path is still broken. Investigate before next deploy.
- **44,427 `mm_kill_switch_events` cumulative** — 44,377 baseline from the 2026-04-29/30 DEMO storm + 50 events since ADR-012 T0 (all on the auto-blocklisted KXMLBSPREAD before its disable). Not contaminating ADR-012 PROD-clock signal.
- **HA-pair invariant:** Fly's default deploy creates a 2-machine HA pair on first PROD deploy. Mitigation in place: subsequent deploys use `--ha=false`; manual `fly scale count 1 --yes` after any deploy that creates extras.
- **Untracked `scripts/hooks/`** in working tree on `main` — operator's local pre-deploy hook scripts. Expected; not committed by design.
- Freshness thresholds differ between CLI and API by design; align operator expectations via `PMCI_MAX_LAG_SECONDS` / API config.

### Carry-forward
- Canonical event lifecycle after settlement (archive vs delete) — ADR pending.
- Production cutover from Kalshi DEMO to live Kalshi after 7-day validation closes — gated on validation outcome, kill_switch investigation, and a separate ADR. With daily-loss already FAILED on day 2, the cutover ADR will need to either re-spec the exit criteria or document accepting the failure mode in production.
- Migration-secrets rotation (two old migrations contain anon JWT + PMCI_API_KEY) — deferred until 7-day clock closes.

---

## Historical detail

Older dated snapshots, sprint tables, and phase-by-phase closeouts were removed from this file to reduce drift. Use git history for prior `system-state.md` content if you need a specific dated snapshot.
