# System State

## Branch
- `chore/infra-hardening-baseline-2026-02-26`

## Current Status (2026-03-04)

### Phase A + B — Complete ✓
- All baseline schema, smoke, and coverage checks passing.
- `scripts/pmci-bootstrap.mjs` fully implemented; `/v1/health/projection-ready` endpoint live.
- **Phase B ingestion signals validated (2026-03-03):**
  - `rolling_success_rate: 1.00` over last 20 observer cycles (1,220 configured pairs)
  - `true_success_rate: 1.00` — true denominator fix confirmed working
  - All five error counters at zero: `kalshi_fetch_errors=0`, `polymarket_fetch_errors=0`, `spread_insert_errors=0`, `pmci_ingestion_errors=0`, `json_parse_errors=0`
  - Freshness lag: 0s for both Kalshi and Polymarket (observer actively cycling ~60s interval)
  - Snapshot growth healthy: ~1,650 new rows/cycle; 320,750 total as of 2026-03-03

### Phase C — API Readiness (SLO partially passing)
- Auth gating (`PMCI_API_KEY`), versioning (`X-PMCI-Version`), request logging (`/v1/health/usage`) all working.
- OpenAPI spec, integration guide, client SDK (`lib/pmci-client.mjs`) committed.
- **SLO status (2026-03-04):** `ingestion_success=1.00 ✓`, `freshness_lag=2003s ✗` (observer down), `api_p95_latency=596ms ✗` (target 500ms; improved from 6,359ms), `projection_ready=false ✗` (blocked by freshness)
  - Observer last cycle: 2026-03-04T00:35Z (~5h stale at cycle time); needs restart
  - p95 latency improved significantly but still above 500ms target

### PMCI Linkage Pipeline Fixes (2026-03-03)
- `parsePolyRef`: title-based entity fallback for numeric/Yes-No Polymarket condition IDs
- `extractTopicSignature`: governor+senate checks now run BEFORE presidential nominee check
- `considerPair`: `sameBlockBonus=0.35` for same specific-signature + last-name-match pairs
- `pmci-politics-insights.mjs`: removed `&category=politics` from coverage calls → 12.6% Kalshi / 7.2% Polymarket (was 0%)
- Canonical events: 2 → 5 (added presidential-election-winner-2028, which-party-wins-2028-us-presidential-election, who-will-trump-nominate-as-fed-chair)

### PMCI Universe Expansion + Ingestion Fix (2026-03-04)
- Canonical events: 5 → **22** (+17 new events)
  - TX Senate (D + R nominee 2026), TX House (TX-02, TX-23, TX-33), NC Senate (R nominee), NC House (NC-01, NC-04)
  - US Government Shutdown 2026, DHS Funding 2026
  - Texas AG GOP Primary 2026, Texas Governor GOP Primary 2026
  - Iran/US/Israel Strike 2026, Iran Strait of Hormuz 2026, Next Iranian Supreme Leader
  - Venezuela Leadership 2026, Fed Rate Decision March 2026
- Provider markets: 1,336 → **2,811** (+1,475 markets after ingestion fix)
- **Ingestion bug fixed:** Polymarket per-candidate binary markets were colliding on `slug#Yes`/`slug#No`. Fixed to use `groupItemTitle` as ref key (`slug#Graham Platner`, etc.). Placeholder slots (Player X, Person X, Option X) now skipped entirely.
- 59 stale proposals referencing old collision refs bulk-rejected; proposer re-run generated 51 fresh candidate-keyed proposals
- Market categories now tracked: 2028 presidential nominees, TX/NC legislative primaries, federal shutdown/DHS, Iran escalation, Venezuela, Fed rate policy

## Known Risks
- All prior in-flight changes committed (2026-03-03, 78 files on `chore/infra-hardening-baseline-2026-02-26`).
- Freshness threshold differs between CLI (`PMCI_MAX_LAG_SECONDS` default 180s) and API (default 120s) — intentional but worth documenting if operators see inconsistency.
- Polymarket universe DEM/REP 2028 nominee markets use "Person X" placeholder names for many slots — entity-based matching can only link markets with real candidate names in the title. Coverage expansion requires Polymarket to fill these placeholders.
- `coverage/summary` endpoint with no category filter counts all provider_markets (including non-politics if future ingestion adds them). Currently safe: all 1,709 markets are political.

## Next Actions
1. **Restart observer** — `npm run start`; freshness lag is ~5h, projection_ready=false. Must resolve before API SLOs can pass.
2. **Review 51 pending proposals** — `/pmci-review`; queue contains fresh candidate-keyed proposals (Maine Senate at 0.97 conf). Accepting correct ones will grow families/links counts.
3. **Fix api_p95_latency SLO** — p95 improved (6,359ms → 596ms) but still above 500ms target. Profile `/v1/market-families` and `/v1/signals/top-divergences`. Run: `/coordinate "diagnose and fix API p95 latency — market-families and top-divergences endpoints"`
4. **Re-run universe ingestion periodically** — `npm run pmci:ingest:politics:universe --reset`; as Polymarket fills placeholder slots with real candidate names, more cross-venue pairs become matchable.
