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

## Phase E — Sports & Crypto Expansion (active)
**Entry criteria:** Phase D semantic closeout complete (met). Coverage/performance targets continue as tracked optimization work during Phase E onboarding.

### E1 — Sports ✅ ACTIVE (schema + ingestion complete, proposer workflow partially implemented on active branch)

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

**Current implementation reality (verified 2026-04-09 acceptance run):**
- `seed:sports:pmci`, `pmci:propose:sports`, and `pmci:audit:sports:packet` exist in `package.json` and are wired to repo scripts.
- Recent branch-local work indicates active E1.5 progress on `fix/e1-5-sports-proposer-2026-04-08`, including `52b413f` (`fix(pmci): add bounded sports e1.5 subset workflow`).
- Branch-local differs from `main` by 2 commits (`52b413f`, `452a784`); E1.5 conclusions below are from the active branch, not `main`.
- Verified run result on this branch (rerun 2026-04-09 18:27 UTC): `npm run pmci:propose:sports` succeeded but returned `considered=0 inserted=0 rejected=0 limit=250`.
- Verified strict audit result on this branch (rerun 2026-04-09 18:28 UTC): `npm run pmci:audit:sports:packet` produced `semantic_violations=0`, `stale_active=19222`, and `unknown_sport=38707` in `docs/reports/latest-sports-audit-packet.json`.
- Conclusion: semantic integrity is clean, but proposer acceptance is still failing. This does **not** justify marking E1.5 complete or merging as a completed acceptance milestone.

**E1 remaining work:**
- [ ] **E1.5 — Sports proposer acceptance**: make `pmci:propose:sports` evaluate real sports candidates and produce non-zero acceptance-ready output, then re-run `pmci:audit:sports:packet`
- [ ] Resolve the verified unknown-sport backlog (**38,707**) and stale-active backlog (**19,222**) blocking useful proposer coverage
- [ ] Clarify branch-versus-main status for current E1.5 work after a passing acceptance run exists
- [ ] Add B.League / Turkish league patterns to sport-inference if still needed after normalization fixes
- [ ] Define canonical event lifecycle for game markets (auto-archive on settle vs. delete)
- [ ] E1 acceptance gate: ≥5 confirmed cross-platform sports pairs with semantic integrity = 0

### E2 — Crypto (pending E1 proposer gate)
- [ ] Define crypto canonical event schema (price-based, continuous, no binary Yes/No)
- [ ] Identify crypto markets on Kalshi + Polymarket (BTC price targets, ETH events)
- [ ] Adapt ingestion for continuous price events vs. binary elections
- [ ] Determine spread computation model for non-binary markets

---

## Phase F — Execution-Readiness Layer (next after E-category onboarding)
**Goal:** Bridge PMCI from intelligence substrate to execution-ready relative-value infrastructure.

**Principle:** PMCI remains the intelligence / canonicalization layer. A downstream execution service should own order placement, inventory, fills, and capital allocation.

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

## Current milestone: E1.5 remediation after verified acceptance failure
E1.1–E1.4 are complete. On 2026-04-09, the actual acceptance flow was run on `fix/e1-5-sports-proposer-2026-04-08`: the proposer completed with zero considered/inserted pairs, while the strict sports audit packet reported zero semantic violations but a large unknown-sport and stale-active backlog. That means E1.5 remains partial, not complete, and should be remediated rather than merged as finished. E2 (crypto) stays gated on a real passing E1 proposer acceptance run.
