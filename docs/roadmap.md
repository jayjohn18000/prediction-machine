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
- [ ] **api_p95_latency < 500ms** — currently 732ms (regressed from 596ms); profile `/v1/market-families` + `/v1/signals/top-divergences`

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

## Phase E — Sports & Crypto Expansion (next)
**Entry criteria:** Phase D semantic closeout complete (met). Coverage/performance targets continue as tracked optimization work during Phase E onboarding.

### E1 — Sports
- [ ] Define sports canonical event schema (team/player-based, short-lived events)
- [ ] Identify sports series tickers on Kalshi (NFL, NBA, MLB game markets)
- [ ] Identify Polymarket sports tag_ids
- [ ] Adapt ingestion for rapid event turnover (game-day settle = market gone next day)
- [ ] Run proposer + reviewer for sports cross-platform pairs
- [ ] Define canonical event lifecycle (closed game markets auto-archive vs. delete)

### E2 — Crypto
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

## Current milestone: Begin Phase E expansion with guarded rollout
Politics semantic integrity closeout is complete. Next milestone is controlled onboarding of sports/crypto while continuing to improve politics coverage and API performance.
