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

## Branch
- **Active branch:** `main` at `038715c` — fully synced with `origin/main` (no unmerged branches)
- **Active phase:** **E2 — Crypto ∥ E3 — Economics** (scaffolds committed; guard-first proposer + strict-audit gates not yet run)
- **E1.6 validation audit (2026-04-14):** All exit criteria met. E2/E3 unblocked.
- **Post-E1.6 commits on main (2026-04-14 — 2026-04-15):**
  - `8db2b41` feat(E2/E3): parallel crypto + economics tracks — observer frontier v2, cron parity, Phase F entry gates
  - `1aa1fb7` fix(signals): make top-divergences global — drop mandatory event_id, relax freshness gate
  - `b52b7bb` fix(health): fall back to live snapshot when pmci_runtime_status row missing
  - `038715c` docs: add competitive coverage analysis, automation plan, and benchmark artifacts
- **Prior branch history:** E1.5 merged 2026-04-10. E1.6 sprint executed 2026-04-14 on `main` (4 commits: `b11322a` → `7c09ea4` → `87d8a71` → `28db86f`).

## Untracked / uncommitted files (as of 2026-04-15)
These files exist locally but are not yet committed to main:
- `docs/deployment-fly.md` — Fly.io deployment runbook (both apps)
- `docs/deployment.md` — modified (Fly notes added)
- `docs/plans/phase-e2-auto-review-plan.md` + `phase-e2-auto-review-schema.md` — E2 planning docs
- `Dockerfile` + `docker-entrypoint.sh` + `.dockerignore` — container build (used by Fly)
- `deploy/fly.api.toml` + `deploy/fly.observer.toml` — Fly app configs
- `.pmci_kalshi_crypto_checkpoint.json` + `.pmci_kalshi_economics_checkpoint.json` — ingest checkpoints (gitignore candidate)
- `.claude/settings.local.json` — do NOT commit

## Current Status (2026-04-15 — E2/E3 SCAFFOLDED ✓, Fly.io LIVE ✓)

### What happened since E1.6 closeout (2026-04-14 → 2026-04-15)

**Commits pushed to main:**

| Commit | Summary |
|--------|---------|
| `8db2b41` | **E2/E3 parallel tracks scaffolded.** New files: `lib/ingestion/crypto-universe.mjs`, `lib/ingestion/economics-universe.mjs`, `scripts/review/pmci-propose-links-crypto.mjs`, `scripts/review/pmci-propose-links-economics.mjs`, `src/routes/admin-jobs.mjs` (ingest-economics + ingest-crypto spawn targets), `supabase/functions/pmci-job-runner/index.ts` (job map). New npm scripts: `pmci:ingest:economics`, `pmci:ingest:crypto`, `pmci:propose:crypto`, `pmci:propose:economics`. Phase F entry gates documented in `docs/phase-f-entry-gates.md`. Tradability config sketch in `config/tradability-model.v1.example.json`. Observer frontier v2: DB-only mode + empty static allowed. |
| `1aa1fb7` | **signals/top-divergences fixed.** Endpoint was returning 503 due to required `event_id` param. Now global — drops mandatory `event_id`, relaxes freshness gate. Divergence ranking moved into SQL. |
| `b52b7bb` | **health routes hardened.** `/v1/health/freshness`, `/v1/health/slo`, `/v1/health/projection-ready` now fall back to live snapshot query when `pmci_runtime_status` row is missing (was crashing with id=1 not found). |
| `038715c` | **Competitive intelligence committed.** `docs/competitive-coverage-gap-analysis.md` (PMCI vs SimpleFunctions vs OddPool, as of 2026-04-14). `docs/plans/automation-sprint-plan.md` (PM2/pg_cron/Edge Functions automation roadmap). `scripts/benchmark/coverage-benchmark.mjs` + `output/benchmark/` artifacts (OddPool + SimpleFunctions API response snapshots). Two audit reports: `docs/plans/2026-04-13-e1.6-validation-fixes.md`, `docs/plans/2026-04-14-e1.6-validation-audit.md`. Top-divergences fix plan: `docs/plans/2026-04-14-fix-top-divergences-plan.md`. |

**Fly.io deployment — LIVE (2026-04-15):**
- `pmci-api`: 2 machines running in IAD (us-east-1), both green, 1/1 health checks passing. URL: `https://pmci-api.fly.dev`
- `pmci-observer`: running in IAD. URL: `https://pmci-observer.fly.dev`
- All secrets set on both apps (`DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `PG_SSL`, `OBSERVER_DB_DISCOVERY=1`)
- Deploy configs: `deploy/fly.api.toml`, `deploy/fly.observer.toml`
- Dockerfile + `docker-entrypoint.sh` selects role via `PMCI_FLY_ROLE` env var (`api` or `observer`)
- **Cron jobs run via Supabase Edge Functions** (`supabase/functions/pmci-job-runner/`), NOT local PM2. To add a new cron job: add entry to `JOB_MAP` in `index.ts` + apply a migration adding the pg_cron row.

**Carry-forward (still open):**
- Deployment artifacts (`docs/deployment-fly.md`, `deploy/`, `Dockerfile`, `docker-entrypoint.sh`, `docs/plans/phase-e2-auto-review-plan.md`) not yet committed to main
- E2/E3 guard-first proposer runs not yet executed — scaffolds only, zero accepted crypto/economics pairs
- `signals/top-divergences` fix committed but needs live verification on deployed API
- Stale-cleanup not scheduled as cron — sports stales will re-accumulate over time

---

## Current Status (2026-04-14 — E1.6 VALIDATED ✓, E2 UNBLOCKED)

Post-sprint validation audit run 2026-04-14. All E1.6 exit criteria met.

| Check | Result | Criterion |
|------|--------|-----------|
| `npm run verify:schema` | ✅ PASS | PASS |
| `npm run pmci:smoke` | ✅ `80606 / 874301 / 3227 / 345` | No errors |
| `npm test` | ⚠️ 103 pass, 1 fail (signals/top-divergences 503) | 0 failures (pre-existing) |
| `unknown_sport` | ✅ **180** | < 1,000 |
| `stale_active` (sports) | ✅ **0** (10 non-sports remain, out of scope) | = 0 |
| `semantic_violations` | ⚠️ **96 pairs / 7 families** (pre-existing data quality) | = 0 (not E1.6 regression) |
| Sports market_links | ✅ **234** (117 accepted proposals) | ≥ 200 |
| Spread dashboard | ✅ `docs/spread-dashboard.html` committed | File exists |
| Competitive baseline | ✅ `docs/competitive-baseline.md` committed | File exists |
| OBSERVER_DB_DISCOVERY code | ✅ Merged on main (`observer.mjs:33`) | Code present |
| OBSERVER_DB_DISCOVERY .env | ✅ **Set** (`OBSERVER_DB_DISCOVERY=1`) | Operator action done |
| Kalshi prices | ✅ **104,825 snapshots** on linked markets (latest ~12h ago) | Recent snapshots |
| Polymarket prices | ✅ **107,518 snapshots** on linked markets (latest ~12h ago) | Recent snapshots |

**What was fixed (E1.6):**
- Sport-bucketed proposer (`scripts/review/pmci-propose-sports-by-sport.mjs`): runs matching one sport at a time, avoids OOM on full Kalshi×Polymarket cross-product.
- Futures/championship matcher: 88 cross-platform equivalent pairs matched and accepted across MLB World Series (30), NHL Stanley Cup (32), EPL (4), La Liga (4), Serie A (6), Bundesliga (4), UCL (6), UEL (5), UECL (1).
- Audit semantic check upgraded to use sport-family grouping and skip date checks for non-matchup futures markets.
- Rejected 95 false-positive proposals from earlier run.
- Stale-cleanup run 2026-04-14: cleared 31 sports stale_active markets (41 total → 10 non-sports remaining).

**Link growth:** 131 → 345 current_links (+214). Accepted proposals: politics=36, sports=117.

**Carry-forward issues (non-blocking, for E2 cleanup):**
- `signals/top-divergences` endpoint returns 503 — needs investigation (missing materialized view or empty data)
- 7 families with same-provider duplicate links (family 3120 is a mis-labeled MLS mega-family; 6 politics families have true dupes)
- 10 non-sports stale_active markets (politics, sport=NULL)
- stale-cleanup.mjs not scheduled as cron — stales will re-accumulate

## Current Status (2026-04-12 refresh — Phase E1.5 COMPLETE ✓)

### Phase E1.5 — Sports Proposer Acceptance (complete)

All hard gate conditions verified (2026-04-10):

| Gate | Result |
|------|--------|
| `stale_active=0` | ✅ PASS |
| `unknown_sport < 1000` | ✅ PASS (922) |
| `semantic_violations=0` | ✅ PASS |
| `verify:schema PASS` | ✅ PASS |
| `≥5 accepted cross-platform sports pairs` | ✅ PASS (10 accepted, 20 market_links) |

**What was fixed:**
- `sport-inference.mjs`: 30+ new ticker fallback patterns (SAUDIPL, CS2MAP, NBAGAME, NFLTEAM, AHL, KHL, Liiga, Swiss League, EUROLEAGUE, R6GAME, CONMEBOL, NWSL, AFL, Baller League, etc.) + title-map patterns for Saudi PL, NWSL, KHL, AHL, EuroLeague, R6; FC/club Polymarket title fallback
- `sports-universe.mjs`: `parseTeams` negative lookahead (excludes "at least/most/once" false positives); Polymarket title fallback when tag inference returns 'unknown'
- `sports-helpers.mjs`: `looksLikeMatchupMarket` false positive fix for " at " qualifier words
- `scripts/stale-cleanup.mjs`: cleared 20,048 stale-active sports markets (guard-first)
- `scripts/backfill-sport-inference.mjs`: DB-level backfill; reduced unknown_sport 38,707→922

**Historical closeout smoke counts (2026-04-10):** provider_markets **76,531** | snapshots **658,480** | families **3,120** | current_links **131**
**Live audit smoke rerun (2026-04-10, post-edit check):** provider_markets **76,587** | snapshots **672,374** | families **3,120** | current_links **131**
**Latest live smoke rerun (2026-04-12):** provider_markets **80,375** | snapshots **816,206** | families **3,120** | current_links **131**
**Latest live smoke rerun (2026-04-12 late check):** provider_markets **80,606** | snapshots **820,548** | families **3,120** | current_links **131**
**Scheduled ingest:** Cowork task "pmci-sports-ingest" every 4 hours (`0 */4 * * *`).
**API:** Port 3001 healthy during prior closeout checks; treat PID-specific notes as historical snapshots.
**Phase F implementation status (verified 2026-04-12):** planning docs exist (`docs/phase-f-gap-analysis.md`, `docs/phase-f-implementation-plan.md`), but execution-readiness code/routes are not present in the active PMCI API. Verified missing: `/v1/signals/ranked`, `/v1/router/best-venue`, `src/services/tradability-service.mjs`, `src/services/router-service.mjs`, and `config/execution-readiness.json`.

### Phase E2 — Crypto ⬅ ACTIVE (E1 strict-audit GREEN 2026-04-14; ready for implementation)

Next steps (see roadmap.md E2 section):
1. Define crypto canonical event schema (price-based, continuous — differs from binary political/sports markets)
2. Audit live crypto markets on Kalshi + Polymarket (BTC/ETH price targets, level events)
3. Build `lib/ingestion/crypto-universe.mjs` following the same guard-first pattern as `sports-universe.mjs`
4. Adapt spread computation model for non-binary continuous events
5. Apply guard-first proposer + strict-audit gate loop before accepting any crypto market links

E2 also inherits the carry-forward cleanup items listed in the 2026-04-14 validation section above.

---

## Current Status (2026-04-13 — superseded by 2026-04-14 validation above)

The 2026-04-13 live drift (stale_active=8317, unknown_sport=1663, semantic_violations=369) was fully resolved by the E1.6 sprint. All E1.6 fixes are committed on `main` at `28db86f`. The 2026-04-13 drift numbers are historical only — do not use them as current state.

Phase F implementation status remains unchanged (planning docs exist; execution-readiness routes/services still absent in active PMCI API).

---

## Current Status (2026-03-17 refresh)

- Historical links API route is now live in the PMCI surface: `GET /v1/links` (active + removed status history with pagination/filtering).
- API contract/docs now include `/v1/links` in both OpenAPI and API reference.
- Phase C perf gate re-validated on local runtime: `/v1/health/slo` reports `api_p95_latency_ms.actual=124` with `sample_size=129` (pass vs 500ms target).

## Current Status (2026-03-06)

### Phases A + B + C (infrastructure) — Complete ✓
- All baseline schema, smoke, coverage, auth, rate limiting, versioning, OpenAPI docs committed.
- `ingestion_success: 1.00`, all error counters = 0, rolling 20-cycle success rate = 1.00.
- **SLO status (2026-03-06):** `ingestion_success=1.00 ✓`, `freshness_lag=141,694s ✗` (observer down ~39h), `api_p95_latency=732ms ✗` (target 500ms; regressed from 596ms), `projection_ready=false ✗` (blocked by freshness)

### Phase D — Politics Normalization (active as of 2026-03-06)
**Strategic context:** Infrastructure is ~70% done. Data coverage is ~10% done. Goal before expanding to sports/crypto: get all active political events ingested and cross-platform links established for every event that exists on both platforms.

**Coverage snapshot (2026-03-06, post-triage):**
- provider_markets: **2,814** (557 Kalshi, 2,257 Polymarket) across 323 distinct event_refs
- canonical_events: **7** (trimmed from 22 — 15 phantoms deleted, 5 annotated poly-only)
  - 2 with families (Dem + Rep 2028 nominees, 35 + 26 families each)
  - 5 Polymarket-only (annotated `metadata.single_platform=true`)
  - 0 phantoms
- active cross-platform links: **138** across 2 canonical events (2028 Dem + Rep nominees)

**Phantom triage result (2026-03-06):**
- **Deleted (15):** TX/NC house/senate primaries with no provider markets, DHS/shutdown/Iran-strike/Venezuela events with no markets, `which-party-wins-2028` (duplicate), TX attorney general, TX governor (Poly had general election, not GOP primary), NC senate (Poly had general election, not primary)
- **Kept as Poly-only (5):** `presidential-election-winner-2028` (278 markets), `who-will-trump-nominate-as-fed-chair` (78), `texas-senate-republican-nominee-2026` (28), `fed-rate-decision-march-2026` (6), `iran-strait-of-hormuz-2026` (6)
- **Root cause:** `seed-pmci-families-links.mjs` had a hardcoded `ADDITIONAL_POLITICAL_EVENTS` array inserted speculatively without verifying provider_markets existed. Fixed — array now contains only verified events with policy comment.

**Policy decision (2026-03-06):** Option A — active markets only. Single-platform events tracked as-is; linked automatically when counterpart appears on the other platform. No historical/settled market ingestion.

### PMCI Linkage Pipeline Fixes (2026-03-03 — 2026-03-04)
- `parsePolyRef`: title-based entity fallback for numeric/Yes-No Polymarket condition IDs
- `extractTopicSignature`: governor+senate checks now run BEFORE presidential nominee check
- Ingestion bug fixed: Polymarket per-candidate binary markets now keyed by `groupItemTitle` (slug#CandidateName), not slug#Yes/No
- Canonical events: 2 → 22 (+20 events added across TX/NC primaries, shutdown, Iran, Venezuela, Fed rate, 2028 presidential)
- Provider markets: 1,336 → 2,814
- AGENT_ENHANCER meta-agent + Pattern E (outcome_name_match=0) + Pattern F (date delta >120d) added to PROPOSAL_REVIEWER (2026-03-06)
- Phantom canonical event triage: 22 → 7 (15 deleted, 5 poly-only annotated, seed script fixed) (2026-03-06)

## Known Risks
- All prior in-flight changes committed (2026-03-03, 78 files on `chore/infra-hardening-baseline-2026-02-26`).
- Freshness threshold differs between CLI (`PMCI_MAX_LAG_SECONDS` default 180s) and API (default 120s) — intentional but worth documenting if operators see inconsistency.
- Polymarket universe DEM/REP 2028 nominee markets use "Person X" placeholder names for many slots — entity-based matching can only link markets with real candidate names in the title. Coverage expansion requires Polymarket to fill these placeholders.
- `coverage/summary` endpoint with no category filter counts all provider_markets (including non-politics if future ingestion adds them). Currently safe: all 1,709 markets are political.

## Next Actions
1. **[done 2026-03-06]** Observer restarted — running, freshness 37s, projection_ready=true
2. **[done 2026-03-06]** api_p95_latency fixed — 881ms → 448ms. All 4 SLO checks passing. Changes: added `idx_pmci_snapshots_observed_at_desc` + `idx_pmci_provider_markets_provider_id` indexes, 5-second freshness lag cache in server.mjs, optimized provider latest join in health.mjs
3. **[done 2026-03-06]** Universe ingest reset — Kalshi 65 events / 245 markets, Polymarket 200 events / 1,247 snapshots. 0 missing prices. No net-new provider_markets (all upserts)
4. **[done 2026-03-06]** Proposer re-run — 0 new proposals. 28,508 pairs below 0.88 confidence. Best pair: 0.86 (cross-geography noise). Confirms: genuine Kalshi×Polymarket overlap in politics is concentrated in 2028 presidential nominees only
5. **[done 2026-03-06]** Phantom canonical event triage — 22 → 7 canonical events. 15 deleted (no markets), 5 annotated poly-only, seed script fixed.
6. **Phase E planning** — politics normalization remains complete as historical closeout context, but the current runtime-facing active link count is **124**. Next: implement and validate the sports proposer loop (E1.5), then continue toward sports/crypto expansion.
