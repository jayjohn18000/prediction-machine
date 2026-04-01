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

### E1 — Sports ✅ ACTIVE (schema + ingestion complete, data accumulating)

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

**E1 remaining work:**
- [ ] Add B.League / Turkish league patterns to sport-inference (reduce unknown count)
- [ ] Run proposer + reviewer for sports cross-platform pairs (after ~1 week of data)
- [ ] Define canonical event lifecycle for game markets (auto-archive on settle vs. delete)
- [ ] E1 acceptance gate: ≥5 confirmed cross-platform sports pairs with semantic integrity = 0

### E2 — Crypto (pending E1 proposer gate)
- [ ] Define crypto canonical event schema (price-based, continuous, no binary Yes/No)
- [ ] Identify crypto markets on Kalshi + Polymarket (BTC price targets, ETH events)
- [ ] Adapt ingestion for continuous price events vs. binary elections
- [ ] Determine spread computation model for non-binary markets

---

## Phase F — Provider Expansion (future)
**Entry criteria:** E1 + E2 complete. Normalization loop battle-tested across 3 categories.

- [ ] Add Metaculus (long-range forecasts, different resolution model)
- [ ] Add Manifold Markets (play-money, research use case)
- [ ] Add PredictIt (US political, if API available)
- [ ] Abstract provider adapter interface (currently Kalshi + Polymarket are hardcoded)
- [ ] Multi-provider proposal engine (N-way matching across 3+ providers per event)

---

## Current milestone: Phase E1 sports data accumulation → proposer run
E1.1 schema and E1.2 ingestion are complete and running. Sports markets ingest every 4 hours. Next milestone: after ~1 week of sports data, run the proposal engine to identify cross-platform sports pairs. UFC 314 (April 12) will bring first MMA markets. E2 (crypto) begins after E1 proposer gate passes.
