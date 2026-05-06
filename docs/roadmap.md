# Roadmap (Infrastructure-First → Normalization → Expansion)

## Phase A — Baseline Stability ✓ complete
- [x] Schema validation gate
- [x] Smoke checks + coverage checks
- [x] SLO health endpoint (`/v1/health/slo`)
- [x] Bootstrap CLI + `/v1/health/projection-ready`

## Phase B — Reliability Hardening ✓ complete
- [x] Observer heartbeat table (`pmci.observer_heartbeats`)
- [x] Error taxonomy: kalshi/poly fetch, spread insert, PMCI ingestion, JSON parse
- [x] Real `ingestion_success` SLO backed by heartbeat rolling rate
- [x] `GET /v1/health/observer` endpoint
- [x] Freshness SLA enforcement: `/v1/signals/*` return 503 when stale
- [x] `PMCI_API_KEY` gate on non-health read endpoints
- [x] `.env.example` documents all `PMCI_*` vars

## Phase C — M2M API Readiness ✓ complete (infrastructure)
- [x] Fix pairsAttempted denominator — true_success_rate backed by pairs_configured
- [x] Rate limiting: @fastify/rate-limit, per-key, configurable via env
- [x] TLS: Caddy reverse proxy config, auto-HTTPS via Let's Encrypt
- [x] /v1/review/* auth-gated, review CLI sends x-pmci-api-key
- [x] X-PMCI-Version response header + api_version in health response bodies
- [x] Per-endpoint request logging (pmci.request_log) + /v1/health/usage endpoint
- [x] Stable API contracts documented (OpenAPI or equivalent) — `docs/openapi.yaml` + `docs/api-reference.md`
- [x] Client SDK / integration guide — `lib/pmci-client.mjs` + `docs/integration-guide.md`
- [x] **api_p95_latency < 500ms** — validated 2026-03-17 at **124ms p95** (`/v1/health/slo`, sample_size=129)

## Phase D — Politics Normalization ✓ PHASE COMPLETE
**Goal:** Every active political event on Kalshi or Polymarket is tracked, and every event present on both platforms has an accepted cross-platform market link.

**Closeout (2026-03-13):**
- Semantic remediation complete; residual invalid active gov/pres links = 0.
- Legacy cleanup applied: 12 families / 37 rows deactivated (`status='removed'`).
- Final rates used for closeout: governor 0.067, president 0.636, senate 0.542.

**Acceptance criteria met:**
- Semantic integrity checks pass with zero residual violations.
- Strict audit packet generation passes.
- Guard logic in proposer prevents recurrence of known invalid classes.

### D Follow-on Backlog (non-blocking carryover)
- Governor D6 coverage threshold uplift (0.067 → target ≥ 0.20)
- Full-universe proposer reruns for additional coverage lift
- Observer continuity and freshness improvements
- API p95 optimization (<500ms target)

**Migration path to Phase E (sports/crypto):**
- Use same guard-first proposer + strict-audit gate loop.
- Start with limited category slices and expand only when semantic drift remains zero.

---

## Phase E — Parallel expansion (Sports complete; E2 crypto ∥ E3 economics active)
**Entry criteria:** Phase D semantic closeout complete (met). Coverage/performance targets continue as tracked optimization work during Phase E onboarding.

**Parallel workstreams (same guard-first + strict-audit pattern):**
| Track | Focus | npm scripts (ingest / propose) |
|-------|--------|-------------------------------|
| **E2 — Crypto** | BTC/ETH/SOL cross-venue, binary spread v1 + canonical schema for harder templates | `pmci:ingest:crypto`, `pmci:propose:crypto` |
| **E3 — Economics / macro** | Fed/CPI/rates-style binary macro | `pmci:ingest:economics`, `pmci:propose:economics` |

**Shared exit criteria (per track):** `npm run verify:schema` PASS, `npm run pmci:smoke` PASS, audit packet at semantic violation budget, no bulk inactivation without inactive-guard.

**Observer v2 — observation frontier:** Static JSON pair lists are optional when DB frontier is enabled (`OBSERVER_DB_DISCOVERY` / `OBSERVER_USE_DB_FRONTIER_ONLY`). Capped SQL over `pmci.market_links` replaces hand-maintained merge-at-scale; see `lib/ingestion/observer-frontier.mjs` and `docs/system-state.md`.

### E1 — Sports ✅ COMPLETE — E1.6 VALIDATED (2026-04-14)

**Completed (2026-03-31 — 2026-04-01):**
- [x] **E1.1 — Schema migration** (`20260331000001_sports_market_fields.sql`): added `sport`, `event_type`, `game_date`, `home_team`, `away_team` to `provider_markets`; added `lifecycle`, `resolves_at` to `canonical_events`
- [x] **E1.1 — Snapshot retention** (`20260331000002_snapshot_retention.sql`): pg_cron job deletes snapshots >30 days at 3am UTC nightly (confirmed live)
- [x] **E1.2 — Sports ingestion wiring**: `lib/ingestion/sports-universe.mjs` fetches Kalshi sports series (by `category='Sports'`, one-shot) + Polymarket sports tags (dynamic keyword match); upserts to `provider_markets` with `category='sports'`
- [x] **E1.2 — Sport inference**: `lib/ingestion/services/sport-inference.mjs` — word-boundary patterns on series title (handles KX-prefixed tickers); covers NFL, NBA, MLB, NHL, NCAAF, NCAAB, MMA, soccer leagues, ATP/WTA tennis, golf, F1, boxing, NASCAR, wrestling, esports
- [x] **E1.2 — Bug fixes** (commit `d0defc5`): fixed Kalshi series filter (prefix→category), market status filter (open→active|open), ATP/WTA inference, Polymarket static slugs→dynamic keyword match
- [x] **Scheduled ingest**: Cowork task "pmci-sports-ingest" runs every 4 hours

**Current DB state (2026-04-01):**
- NBA: 304 | MLB: 110 | Tennis: 22 | Boxing: 18 | NCAAB: 18 | Unknown: 158 | MMA: 0
- Unknown 158 = Japanese B.League + Turkish Super Liga (not yet mapped in sport-inference)
- MMA 0 = expected (UFC 314 is April 12; markets appear ~1 week before fight)

**Completed (2026-04-02):**
- [x] **E1.3 — Proposer hardening** (commit `c5701e6`): 3 guards added to `lib/matching/proposal-engine.mjs`
  - Expired-market filter: `WHERE close_time IS NULL OR close_time > NOW()` on both market queries
  - Dedup check: queries `market_links` for active link on `idA` before any insert
  - Title-similarity floor: skips equiv proposals where `title_similarity < 0.30 AND slug_similarity < 0.20`
  - New script: `scripts/review/pmci-clear-stale-proposals.mjs` + `pmci:clear:stale` npm script; cleared 5 stale proposals
- [x] **E1.4 — Polymarket sports fix** (commit `c5701e6`): 4 fixes to `lib/ingestion/sports-universe.mjs`
  - Removed invalid `active=true` param (root cause of 0 Polymarket sports markets) → replaced with `closed=false&archived=false`
  - Added `fetchPolymarketSportsTagsFromSportsEndpoint()` calling Gamma `/sports` endpoint for authoritative tag IDs
  - `outcomePrices` + `clobTokenIds` now parsed via `JSON.parse()` (Gamma returns stringified arrays)
  - Status mapping: `isLive ? "active" : "closed"` (was `m?.active ? "open" : "closed"`)

**Current DB state (live smoke, 2026-04-09 18:30 UTC):**
- provider_markets: 71,750 | snapshots: 415,249 | families: 3,119 | current_links: 124
- `npm run verify:schema` passes
- `npm run pmci:smoke` passes

**E1.5 COMPLETE (historical closeout) — verified 2026-04-10:**
- `fix/e1-5-sports-proposer-2026-04-08` merged to `main` on 2026-04-10.
- Proposer now returns `considered=10,756,217` (was 0); 10 cross-platform soccer pairs accepted.
- Final audit: `stale_active=0`, `unknown_sport=922`, `semantic_violations=0`, `verify:schema PASS`.
- Historical smoke snapshot (2026-04-10 closeout): provider_markets **76,531** | snapshots **658,480** | families **3,120** | current_links **131**.
- Live smoke rerun (2026-04-10, post-edit check): provider_markets **76,587** | snapshots **672,374** | families **3,120** | current_links **131**.
- Branch-local note at audit time: local `main` is ahead of `origin/main` by 6 commits with unrelated uncommitted workflow-doc edits in the working tree.
- Live audit refresh (2026-04-12): `npm run verify:schema` PASS; `npm run pmci:smoke` = provider_markets **80,375** | snapshots **816,206** | families **3,120** | current_links **131**.
- Live smoke rerun (2026-04-12 late check): provider_markets **80,606** | snapshots **820,548** | families **3,120** | current_links **131**.
- Live audit refresh (2026-04-13): `npm run verify:schema` PASS; `npm run pmci:smoke` = provider_markets **80,606** | snapshots **834,102** | families **3,120** | current_links **131**.
- Live proposer/audit (2026-04-13): `npm run pmci:propose:sports` => `considered=12,374,090 inserted=66 rejected=12,373,696`; `npm run pmci:audit:sports:packet` => `stale_active=8,317`, `unknown_sport=1,663`, `semantic_violations=369`.
- Branch-local note (2026-04-13): local `main...origin/main [ahead 9]` with unrelated workflow/doc/script edits and untracked files in the working tree; no separate feature branch active during this audit.

**E1 remaining work (post-E1.5 historical closeout, refreshed by 2026-04-13 live evidence):**
- [x] **E1.5 — Sports proposer acceptance** ✓ COMPLETE (2026-04-10)
- [x] **E1.6 — Sports execution-readiness sprint** ✓ VALIDATED (2026-04-14)
  - All hard gates passed: unknown_sport=180 (<1000), sports stale_active=0, sports links=234 (≥200)
  - verify:schema PASS, pmci:smoke PASS (80,606 / 874,301 / 3,227 / 345)
  - OBSERVER_DB_DISCOVERY=1 active; bilateral prices flowing (104K Kalshi + 107K Polymarket snapshots on linked markets)
  - Spread dashboard + competitive baseline committed
  - See [`docs/plans/e1.6-sports-execution-readiness-sprint.md`](plans/e1.6-sports-execution-readiness-sprint.md) for full plan
- [x] **E1.7 — Bilateral linking hygiene (Phase G workstream)** ✓ CLOSED (2026-04-19)
  - Fixed three attachment-path bugs (polluted team strings, suffix-variant canonical events, provider-dominated batch ordering) — see [`phase-g-bilateral-linking-postmortem.md`](plans/phase-g-bilateral-linking-postmortem.md)
  - Shipped classifier enrichment (political outcome key, sports-total line params, innings params, soccer-draw rule) + reslot migration
  - Applied to prod 2026-04-19: reslot moved 1,412 / 4,191 (~34%) sports+politics pm rows; sports bilateral-ready slots 88 → 104 (+16); overfilled share 40.5% → 33.0%
  - Phase 1 reconnaissance confirmed ~95% of solo-slot pool is true coverage gap, not classifier-fixable — de-prioritizes further Option A work in favor of ingestion breadth
  - Full results appendix: [`phase-g-phase2-results.md`](plans/phase-g-phase2-results.md)
- [ ] Define canonical event lifecycle for game markets (auto-archive on settle vs. delete)

### E2 — Crypto (parallel with E3)
- [x] Scaffold ingestion `lib/ingestion/crypto-universe.mjs` + `npm run pmci:ingest:crypto`
- [x] Guard-first proposer scaffold `npm run pmci:propose:crypto` (asset-bucket prefilter)
- [ ] Define crypto canonical event schema (price-based, continuous, non-binary templates)
- [ ] Adapt spread computation for non-binary / ladder markets where YES/NO mid is insufficient
- [ ] Strict-audit packet + semantic gates at acceptance (same pattern as sports)

### E3 — Economics / macro (parallel with E2)
- [x] Scaffold ingestion `lib/ingestion/economics-universe.mjs` + `npm run pmci:ingest:economics` (Kalshi macro series + Poly tag/keyword discovery; category `economics`)
- [x] Macro keyword proposer scaffold `npm run pmci:propose:economics`
- [ ] Dedicated semantic guards (resolution timing, Fed meeting ids, outcome labels) + audit packet
- [ ] Expand Kalshi series / Polymarket tag coverage from competitive benchmarks

---

---

## Phase MM — Market-Making MVP on Kalshi (post-arb-pivot, ACTIVE)

**Status:** PROD live capital running under ADR-012, day 4 of 7 (hour ~90 of 168 as of 2026-05-06). T0 = 2026-05-02T22:37:20Z; expires 2026-05-09T22:37:20Z.

**Origin:** Adopted as the successor thesis after ADR-002 closed the Kalshi+Polymarket arbitrage thesis RED on 2026-04-24. ADR-003 accepted Kalshi-only MM as the MVP successor; ADR-004 retained Polymarket as an information-only wallet-flow source. The arb pivot is archive-only at `docs/archive/pivot-2026-04/`.

### MM W1–W6 — feature build (✅ complete 2026-04-28)
- W1: Kalshi L2 depth ingestion (`pmci.provider_market_depth`, WS auth, idempotent writes).
- W2: order placement, client_order_id format (Contract R9), fair_value_at_fill semantics (Contract R8), cancel-on-place sequencing (Contract R11).
- W3: order reconciler, post-fill backfill cron, fill ingestion.
- W4: kill-switch wiring (`mm_kill_switch_events`, watchdogs, blocklist).
- W5: PnL snapshot writer (`mm_pnl_snapshots`), per-market R7 attribution.
- W6: 7-day continuous-quote test scaffolding, daily ticker rotator, 24h heartbeat verifier.
- All merged 2026-04-28 → 2026-05-04 across triage tracks A–M and rotator-quality `de5fbc3`.

### MM-Test-1 (DEMO 7-day clock, ADR-008 → ADR-010) — ✗ paused early 2026-05-02
- T0 = 2026-04-28T17:41:28Z; paused at hour ~92 of 168.
- Daily-loss criterion RECORDED-FAIL on day 2 (44,372 `mm_kill_switch_events` from the storm; PnL=−2,341.66c vs configured 2,000c cap).
- Useful for plumbing validation (kill-switch fires correctly, fill ingestion persists, PnL writer healthy). Not useful for strategy validation. Superseded by ADR-012 PROD clock.

### MM-Test-2 (PROD 7-day clock, ADR-011 + ADR-012) — IN FLIGHT
- T0 = 2026-05-02T22:37:20Z; expires 2026-05-09T22:37:20Z.
- Risk envelope: $5/day per-market loss cap, $30 notional position cap, `min_half_spread=2c`, toxicity=200, stale_quote=300s.
- Universe: rotator-managed daily, 1–2 markets at a time per ADR-011 (in practice 8 depth-subscribed, ≤8 enabled, depending on rotator cycle and auto-blocklist state).
- **Per-criterion at hour 90 (live evidence; ADR-013-reframed criterion #1 in effect):**
  - System uptime ≥90% across rolling 30-min windows (ADR-013): **RECORDED-FAIL** — 46.41% live (84/181 windows active); dormancy budget exceeded by 63 windows; mathematically unrecoverable. 34.5h dominant gap on day 3.
  - Net positive PnL after fees: **marginal FAIL** — cumulative −89.0c after 3.7 days (well inside $5/day budget).
  - ≤1 auto-flatten event: **AT-RISK** — 50 killswitch events since T0 (all on now-blocklisted KXMLBSPREAD); 0 in last 24h.
  - Zero `daily_loss_limit_cents=500` breach: **PASS**.
  - Per-market R7 attribution legible: **PASS** (5-min cadence, all columns populated).
  - Lane-13 fee reconciliation ≤2%: **PENDING** (awaits Kalshi monthly statement).
- Verdict at hour 168: ADR-014 (TBD 2026-05-09T22:37Z) records pass/fail per dimension and the cutover decision (continue, ramp, or roll back). ADR-013 (Accepted 2026-05-06) is the criterion-reframe ADR; ADR-014 is the verdict ADR.

### MM follow-on (gated on hour-168 verdict)
- **Hour-96 ramp decision** (already past): $30 → $50 position cap if all green. Operator decision; not automatic. Skipped to date.
- **Runtime depth-sub rebuild on universe change** (P0 post-clock): orchestrator must reconcile its depth subscriber set against `mm_market_config WHERE enabled=true` per tick — root cause of the 35h dormancy.
- **Cosmetic fix:** rotator notes string template still hardcodes `mode=demo`.
- **Track B residual:** migration-secrets rotation (anon JWT + PMCI_API_KEY in two old migrations) deferred until clock closes.
- **Polymarket indexer W2** (live Polygon ingestion, `pmci-poly-indexer` Fly app): next workstream after MM clock closes.

---

## Phase F — Execution-Readiness Layer (paused; superseded by Phase MM as the active execution thesis)
**Goal:** Bridge PMCI from intelligence substrate to execution-ready relative-value infrastructure.

**Principle:** PMCI remains the intelligence / canonicalization layer. A downstream execution service should own order placement, inventory, fills, and capital allocation.

**Entry gates (do not start broad F1 implementation until met):** See [`docs/phase-f-entry-gates.md`](phase-f-entry-gates.md) and versioned example config [`config/tradability-model.v1.example.json`](../config/tradability-model.v1.example.json).

### F1 — Tradability & Net-Edge Modeling
- [ ] Add family / venue-pair tradability model including:
  - mapping confidence
  - relationship type (`identical`, `equivalent`, `proxy`, `correlated`)
  - freshness eligibility
  - market status / lifecycle eligibility
  - liquidity / depth estimate
  - fee estimate
  - slippage estimate
  - latency / stale-risk buffer
  - net edge after execution costs
- [ ] Restrict early tradeable universe to `identical` / `equivalent` relationships only
- [ ] Add `tradeable=true|false` gating and family-level execution score

### F2 — Execution-Readiness Metrics
- [ ] Add canonical metrics for:
  - fee-adjusted edge
  - slippage-adjusted edge
  - opportunity persistence / edge half-life
  - stale-read rate
  - estimated fillable size
  - false-opportunity rate
  - consensus price per family
  - routing score / best-venue score
- [ ] Define deterministic computation and versioning rules for execution-facing metrics

### F3 — Execution-Facing API Surface
- [ ] Expose execution-readiness surfaces from the active PMCI API (`src/api.mjs`) for ranked, machine-facing consumption
- [ ] Prefer PMCI-aligned endpoints such as:
  - `/v1/signals/ranked`
  - `/v1/signals/divergence`
  - `/v1/market-families`
  - `/v1/market-links`
  - `/v1/router/best-venue`
- [ ] Keep schema contracts strict and versioned; no silent breaking changes

### Phase F exit criteria
- [ ] PMCI can rank opportunities by **net executable edge**, not just raw divergence
- [ ] Fee/slippage assumptions are explicit, reviewable, and reproducible
- [ ] Early deployment universe is restricted to structurally valid families
- [ ] Opportunity quality is comparable across regimes and venue pairs

## Phase G — Paper Trader / Shadow Execution
**Goal:** Validate whether PMCI opportunities survive realistic execution assumptions before live capital deployment.

- [ ] Build paper execution service consuming PMCI execution candidates
- [ ] Simulate maker/taker behavior, latency delay, partial fills, missed fills, and cancels
- [ ] Track synthetic portfolio, venue inventory, expected vs realized edge, PnL, drawdown, and capital utilization
- [ ] Add audit log of why each simulated trade was entered, skipped, or exited

### Phase G exit criteria
- [ ] At least one narrow family set shows repeatable positive **net paper edge** after fees/slippage assumptions
- [ ] Fill assumptions and opportunity decay are measured rather than guessed
- [ ] False-positive trade candidates are attributable by family, venue pair, and relationship type
- [ ] Paper results justify a small-capital live pilot

## Phase H — Guarded Live Pilot
**Goal:** Deploy small-capital live execution with strict operational and risk guardrails.

- [ ] Restrict scope to highest-confidence `identical` / `equivalent` linked markets only
- [ ] Limit initial live deployment to 1–2 categories
- [ ] Build order-intent model and venue-specific execution adapters
- [ ] Add hard kill switches for stale data, venue instability, and mapping-confidence degradation
- [ ] Add exposure caps by family, venue, and day
- [ ] Add order-state reconciliation and idempotent signal-to-order handling
- [ ] Monitor live expected-vs-realized edge with replayable audit logs

### Phase H exit criteria
- [ ] Live execution behaves within defined risk limits
- [ ] Signal-to-fill and expected-vs-realized edge remain within tolerance
- [ ] Operational incidents are understood and recoverable
- [ ] Strategy shows repeatable fee-aware execution quality on a narrow universe

## Phase I — Full Execution Layer & Capital Strategy
**Goal:** Scale from validated pilot to a full relative-value execution platform and associated monetization paths.

- [ ] Add portfolio / risk engine for capital allocation and exposure management
- [ ] Add multi-strategy routing across family types and venue pairs
- [ ] Add real-time execution monitoring, replay, and anomaly detection
- [ ] Add venue-pair performance ranking and allocator logic
- [ ] Evaluate monetization layers:
  - proprietary execution
  - signal / divergence / execution-readiness data products
  - partner integrations using canonical IDs and execution intelligence

## Phase J — Provider Expansion (future)
**Entry criteria:** E-category onboarding complete and execution-readiness loop battle-tested.

- [ ] Add Metaculus (long-range forecasts, different resolution model)
- [ ] Add Manifold Markets (play-money, research use case)
- [ ] Add PredictIt (US political, if API available)
- [ ] Abstract provider adapter interface (currently Kalshi + Polymarket are hardcoded)
- [ ] Multi-provider proposal engine (N-way matching across 3+ providers per event)

---

## Current milestone: Phase MM — PROD 7-day continuous-quote clock (ADR-012)

**Active phase since 2026-05-02:** Kalshi-only MM with live capital. Operator-driven succession of the closed arb thesis (ADR-002/003). E2 (crypto cross-linking) and E3 (economics/macro cross-linking) are paused for the duration of the MM validation; their scaffolds are merged but no new acceptance work is happening.

**Live state (2026-05-06 hour 90 of 168):** see `docs/system-state.md` § Current status block for the canonical numbers and per-criterion progress. Highlights: net PnL −89.0c cumulative; 0 daily_loss breaches; 0 killswitch events in last 24h; 34.5h dominant dormancy on day 3 (live uptime = 46.41%, ADR-013 criterion #1 RECORDED-FAIL). Verdict at hour 168 → ADR-014 (placeholder; ADR-013 is the criterion-reframe ADR).

**Post-MM resumption plan:**
- If MM-Test-2 passes (or accepts known-failures into ADR-014 cutover spec): continue MM operationally; pick up Polymarket Indexer W2 as the next track.
- If MM-Test-2 fails decisively: roll back to DEMO; reconvene strategy.
- E2 / E3 cross-linking work resumes only after MM operational shape is settled (no contention for engineering attention during the active 7-day clock).

**Historical anchor (E1.6 sprint, 2026-04-14):** active `pmci.market_links` row count for sports = 234 legs (≈108 families bilaterally linked); E1 strict-audit GREEN; see `docs/plans/e1.6-sports-execution-readiness-sprint.md`.

**E1.6 carry-forward (non-blocking, deferred to post-MM):**
- `signals/top-divergences` endpoint returns 503 (1 test failure)
- 7 families with same-provider duplicate links (96 violation pairs); family 3120 mis-labeled as politics
- 10 non-sports stale_active markets (politics, sport=NULL)
- stale-cleanup.mjs not yet scheduled as cron

Latest live smoke snapshot (2026-05-06): provider_markets=233,987 / snapshots=9,070,901 / families=205 / current_links=356 (per `pmci-api.fly.dev/v1/health/freshness`). Smoke counts are runtime-volatile; use the live endpoint or `npm run pmci:smoke` for current totals.
