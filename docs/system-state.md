# System State

## Legacy vs active runtime surfaces
- **Active PMCI API:** `src/api.mjs` (Fastify). Run with `npm run api:pmci`. Serves `/v1/health/*`, `/v1/coverage*`, `/v1/markets/*`, `/v1/market-families`, `/v1/market-links`, `/v1/signals/*`, `/v1/review/*`, `/v1/resolve/link`.
- **Legacy API:** Root `api.mjs` (Node HTTP). Run with `npm run api`. Execution-intelligence endpoints only (`/signals/top`, `/execution-decision`, `/routing-decisions/top`). Deprecated in favor of `src/api.mjs` for PMCI; this file is retained for execution-signal use until a sunset milestone. Do not add new PMCI routes here.

## Branch
- `chore/infra-hardening-baseline-2026-02-26`

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
6. **Phase E planning** — politics normalization is complete given current Kalshi×Polymarket overlap. Observer running, all SLOs green, 138 active links across 2 canonical events. Next: plan sports + crypto expansion. Run `/project-status` to confirm Phase D exit criteria
