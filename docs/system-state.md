# System State

## Legacy vs active runtime surfaces
- **Active PMCI API:** `src/api.mjs` (Fastify). Run with `npm run api:pmci` (or `npm run api:pmci:dev`). Serves `/v1/health/*`, `/v1/coverage*`, `/v1/markets/*`, `/v1/market-families`, `/v1/market-links`, `/v1/signals/*`, `/v1/review/*`, `/v1/resolve/link`.
- **Legacy API:** Root `api.mjs` (Node HTTP). Run with `npm run api` (or `npm run api:dev`). Execution-intelligence endpoints only (`/signals/top`, `/execution-decision`, `/routing-decisions/top`). Deprecated in favor of `src/api.mjs` for PMCI; this file is retained for execution-signal use until a sunset milestone. Do not add new PMCI routes here.

## Script ownership boundaries
- `api:pmci*` scripts own PMCI `/v1/*` runtime behavior.
- `api*` scripts (without `:pmci`) are legacy execution API only.
- `start` / `observe:spreads` own observer ingestion loop execution.
- `pmci:*` scripts are PMCI operational workflows (ingest/probe/smoke/review/audit/check), not API server entrypoints.

## Branch
- **E1.5 merged to main:** `fix/e1-5-sports-proposer-2026-04-08` → `main` (2026-04-10)
- Active phase: **E2** (next phase, unblocked)
- **Live audit branch state (2026-04-10):** local `main` is ahead of `origin/main` by 6 commits, with unrelated uncommitted workflow-doc edits in the working tree. No separate feature branch was active during this audit.
- **Live audit branch state (2026-04-12):** local `main...origin/main [ahead 7]` with unrelated workflow/doc/script edits in the working tree. No separate feature branch was active during this audit.
- **Live audit branch state (2026-04-12 late check):** local `main...origin/main [ahead 8]` with unrelated workflow/doc/script edits in the working tree. No separate feature branch was active during this audit.
- **Live audit branch state (2026-04-13):** local `main...origin/main [ahead 9]` with unrelated workflow/doc/script edits and untracked files in the working tree. No separate feature branch was active during this audit.

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

### Phase E2 — Crypto ⬅ ACTIVE (unblocked 2026-04-12; current working phase)

Next steps (see roadmap.md E2 section):
1. Define crypto canonical event schema (price-based, continuous — differs from binary political/sports markets)
2. Audit live crypto markets on Kalshi + Polymarket (BTC/ETH price targets, level events)
3. Build `lib/ingestion/crypto-universe.mjs` following the same guard-first pattern as `sports-universe.mjs`
4. Adapt spread computation model for non-binary continuous events
5. Apply guard-first proposer + strict-audit gate loop before accepting any crypto market links

---

## Current Status (2026-04-13 refresh — live drift detected after E1.5 closeout)

### Phase E1.5 — historical closeout remains true, but live strict-audit is red

Historical closeout (2026-04-10) still stands as a past pass event, but this live rerun shows drift:

| Check | Result |
|------|--------|
| `npm run verify:schema` | ✅ PASS |
| `npm run pmci:smoke` | ✅ `provider_markets=80606`, `snapshots=834102`, `families=3120`, `current_links=131` |
| `npm run pmci:propose:sports` | ⚠️ `considered=12374090`, `inserted=66`, `rejected=12373696` |
| `npm run pmci:audit:sports:packet` | ❌ `stale_active=8317`, `unknown_sport=1663`, `semantic_violations=369` |
| API port 3001 probe during audit script | ⚠️ `PORT_3001_NOT_LISTENING` / `API_UNREACHABLE` |

Interpretation:
- Do not erase E1.5 historical closeout claims, but treat them as historical snapshots.
- Current runtime state requires E1 stabilization before claiming clean strict-audit health.
- E2 remains unblocked at planning level only; avoid claiming active E2 implementation while E1 strict-audit is red.

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
