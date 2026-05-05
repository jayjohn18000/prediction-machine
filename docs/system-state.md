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

## Current status (2026-05-05)

- **Branch / phase:** `main` at HEAD `de5fbc3` (Track M + rotator-quality merge wave). **PROD MM live capital, day 3 of 7 (ADR-012 clock).** T0 = 2026-05-02T22:37:20.567Z; expires 2026-05-09T22:37:20Z. ~hour 64 of 168 elapsed. **Continuous-quote criterion is at-risk** — see Known risks below.
- **Production runtime (3 Fly apps):**
  - `pmci-api.fly.dev` — Fastify API + `/v1/mm/*` admin routes. ✅ Healthy (lag=6s, status=ok).
  - `pmci-observer.fly.dev` — observer loop. **Public DNS still unresolvable** (same as 2026-05-03/04), but `provider_market_snapshots` advanced from 6,595,519 → 8,711,852 since the 2026-05-04 sync (+2.1M), so internal ingestion path is healthy and yesterday's apparent stall was the real issue, not a measurement artifact.
  - `pmci-mm-runtime.fly.dev` — MM orchestrator, single-instance invariant, `MM_RUN_MODE=prod`. Started 2026-05-05T02:47:25Z. Process alive (`loopTick=7713`, `idleHeartbeatAt` advancing) but `severity=warn`, `ready=false`, and **no orders placed since 2026-05-05T03:15:17Z**.
- **MM live state (2026-05-05 14:50Z, ~T0+64h13m):** 8 enabled PROD markets (full rotator-driven sports/crypto rotation since yesterday's NBA games closed); lifetime `mm_orders=61,556` (+1,143 vs 2026-05-04) / 24h=1,140 / 6h=**0** / 1h=**0**; lifetime `mm_fills=425` (+102) / 24h=99; lifetime `mm_kill_switch_events=44,427` with 24h delta = **5** (3× `reject_storm`, 1× `consecutive_adverse_fills`, 1× `fill_rate_floor` — all firing on the now-blocklisted `KXMLBSPREAD-26MAY042138CWSLAA-CWS7` before its 02:50Z auto-disable); `mm_pnl_snapshots_24h=2,288`, latest snapshot 2026-05-05T14:45:00Z; net PnL since ADR-012 T0 = **−77.8c** (spread_capture +311.5, adverse −159.2, inv_drift −7.0, fees −223). `mm-ingest-outcomes` cron writing: `market_outcomes=119` (+6 in 24h).
- **24h order distribution:** only 3 distinct markets quoted in the last 24h, all from yesterday's universe: `KXNBATOTAL-26MAY04MINSAS-220` (487 orders), `KXMLBSPREAD-26MAY042138CWSLAA-CWS7` (404 orders, all in a 2-hour window before auto-blocklist), `KXNBATOTAL-26MAY04MINSAS-232` (249 orders). Last order at 03:15:17Z. **Today's 8 rotator-enabled markets have received zero orders.**
- **Health endpoint mismatch (root cause for the pause):** `/health/mm` reports `enabledMarketsCount=8` (correct) but `depthSubscribedConfigured=1` — the only ticker subscribed for depth is `KXMLBSPREAD-26MAY042138CWSLAA-CWS7`, which is now in `mm_ticker_blocklist`. The orchestrator started at 02:47Z with yesterday's depth set, and the rotator swap → blocklist event left it without any live depth feed. The new rotator-disable-watcher cron (5min) flipped enabled→false on KXMLBSPREAD but the depth subscription set isn't being rebuilt mid-run for the new universe. Operator restart of `pmci-mm-runtime` (or admin trigger that resyncs depth subs) should clear it.
- **API freshness (2026-05-05 13:31Z):** Kalshi + Polymarket lag = **6s** (healthy band, well under 300s). `provider_markets=212,710` (+748); `snapshots=8,711,852` (+2.1M — caught up); `families=205` (unchanged); `current_links=356` (unchanged).
- **Polymarket indexer state:** unchanged — schema + reorg state machine + read-only client namespace + CI lint guard all merged. `pmci.poly_wallet_trades=0` (W2 ingestion not yet started). `pmci-poly-indexer` Fly app not deployed.
- **Cron:** existing MM stack (post-fill backfill / P&L snapshot / `mm-ingest-outcomes` / 24h heartbeat) plus the new `mm-rotator-disable-watcher` (5min) + multi-anchor MLB/NBA UTC rotators landed in `de5fbc3`. All writing rows. The reject-rate auto-blocklist works (auto-disabled KXMLBSPREAD with 314/404 = 77.7% reject rate).
- **Today's universe (rotator-managed):** `KXNHLSERIES-26MINCOLR2-MIN`, `KXNBAGAME-26MAY08SASMIN-SAS`, `KXMLBTOTAL-26MAY041940CINCHC-10`, `KXPGATOUR-ONMBC26-BHOR`, `KXMETGALA-26-DUA`, 3× BTC monthly (`KXBTCMAXMON-BTC-26MAY31-{8500000,8750000,9000000}`). `min_half_spread_cents=1` and `hard_position_limit=20` on all 8 — matches the rotator's PROD defaults from `de5fbc3`. Notes still read `mode=demo` (cosmetic regression — M.5 fixed runtime mode resolution but not the notes string).
- **Ops:** `npm run pmci:status` for API health + smoke counts. `curl -sS https://pmci-mm-runtime.fly.dev/health/mm` for MM runtime status. `curl -sS -H "X-PMCI-API-KEY: $PMCI_API_KEY" https://pmci-api.fly.dev/v1/mm/{markets,orders,positions,pnl,fills,kill-switch-events}` for runtime dashboard.

### Drift from ADR-008 (captured retroactively in ADR-010, 2026-05-01) — historical

ADR-008 specified "5 hand-curated demo markets continuously quoted for 7 days." The actual test design as of 2026-04-30 included 8 markets + daily rotator + 24h heartbeat verifier. Then on 2026-05-02 the DEMO clock was paused early (per ADR-012) when the operator pivoted to PROD live capital. Both ADR-008 and ADR-010 are now superseded for active operations by ADR-012; preserved for historical audit context.

### Open work (post 2026-05-02 cutover)

- **PROD 7-day clock (ADR-012)** running — verdict at hour 168 (2026-05-09T22:37Z) recorded in ADR-013 (TBD). Per-criterion: continuous quoting on ≥1 market, net positive P&L net-of-fees, ≤1 auto-flatten, zero `daily_loss_limit_cents=500` breach, legible per-market R7 attribution, lane-13 fee-statement reconciliation ≤2% variance. **Continuous-quoting criterion currently breaks any 1h rolling window since 2026-05-05T03:15Z** — see Known risks.
- **`mm_fills.kalshi_*_fee_cents` writer wiring (lane-13 follow-up):** columns exist; Track M (`fe38286`) wired the writer. Verify population on the next ≥1 fill landed by today's universe (older fills will still carry NULL — only fills 320+ from 2026-05-04 onwards have populated fee columns per the prior sync).
- **Worst-trade alarm (Track M):** merged in `fe38286`. Watch for first alarm fire on a today-universe fill once quoting resumes.
- **Track B residual (deferred):** migration-secrets rotation (anon JWT + PMCI_API_KEY in two old migrations) is intentionally deferred until the PROD 7-day clock closes — see `track-b-rotate-migration-secrets`.
- **Indexer W2 (Polymarket on-chain ingestion):** unchanged; remains next workstream once the MM clock closes.

### Known risks (2026-05-05)

- 🚨 **Quoting paused ~11h on the active 7-day clock.** Last `mm_orders.placed_at` = 2026-05-05T03:15:17Z. `orders_6h=0`, `orders_1h=0`. The 8 rotator-seeded markets have not been quoted today. Root cause traced above (depth subscription set is still on yesterday's now-disabled ticker). **Recommended operator action: restart `pmci-mm-runtime` to refresh the depth subscriber's universe**, then verify `/health/mm` shows `depthSubscribedConfigured=8` and orders begin flowing within one tick.
- **Auto-blocklist functioning correctly:** `KXMLBSPREAD-26MAY042138CWSLAA-CWS7` blocked at 02:50Z for `high_reject_rate` (314/404 = 77.7%). Expires 2026-05-06T14:50Z. The `de5fbc3` reject-rate watcher worked as designed. `KXLCPIMAXYOY-27-P4.5` still blocked from 2026-05-04 (`encoding_bug`, expires 2026-05-11). No action needed.
- **Cosmetic: rotator notes read `mode=demo` on PROD-running config rows.** All 8 enabled rows carry `notes: "rotator-managed mode=demo …"` while `kalshiEnv.runMode=prod` is the actual deploy state. M.5 in `de5fbc3` resolved the rotator's mode lookup but the notes string template wasn't updated. Cosmetic only — do not let it confuse the next session into thinking the runtime is on DEMO.
- **WS depth staleness on `KXMLBSPREAD` (136s)** — informational, since the ticker is blocklisted; will clear on runtime restart.
- **Observer DNS unresolvable** (carry-forward from 2026-05-03/04): `pmci-observer.fly.dev` doesn't resolve publicly. Snapshots advanced +2.1M since last sync, so the work is happening — but the verification path is still broken. Investigate before next deploy.
- **44,427 `mm_kill_switch_events` cumulative** — 44,377 baseline from the 2026-04-29/30 DEMO storm + 50 events since ADR-012 T0. All recent events are explainable by the watchdog/auto-blocklist + cutover-window stale-DEMO-rows. Not contaminating ADR-012 PROD-clock signal.
- **HA-pair invariant:** Fly's default deploy creates a 2-machine HA pair on first PROD deploy. Mitigation in place: subsequent deploys use `--ha=false`; manual `fly scale count 1 --yes` after any deploy that creates extras. Document in MM runtime runbook.
- **Untracked `scripts/hooks/`** in working tree on `main` — operator's local pre-deploy hook scripts. Expected; not committed by design.
- Freshness thresholds differ between CLI and API by design; align operator expectations via `PMCI_MAX_LAG_SECONDS` / API config.

### Carry-forward
- Canonical event lifecycle after settlement (archive vs delete) — ADR pending.
- Production cutover from Kalshi DEMO to live Kalshi after 7-day validation closes — gated on validation outcome, kill_switch investigation, and a separate ADR. With daily-loss already FAILED on day 2, the cutover ADR will need to either re-spec the exit criteria or document accepting the failure mode in production.
- Migration-secrets rotation (two old migrations contain anon JWT + PMCI_API_KEY) — deferred until 7-day clock closes.

---

## Historical detail

Older dated snapshots, sprint tables, and phase-by-phase closeouts were removed from this file to reduce drift. Use git history for prior `system-state.md` content if you need a specific dated snapshot.
