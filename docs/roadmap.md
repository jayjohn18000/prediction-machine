# Roadmap (Infrastructure-First)

## Phase A — Baseline Stability (complete)
- [x] Schema validation gate
- [x] Smoke checks + coverage checks
- [x] SLO health endpoint (`/v1/health/slo`)
- [x] Bootstrap CLI + `/v1/health/projection-ready`

## Phase B — Reliability Hardening (complete)
- [x] Observer heartbeat table (`pmci.observer_heartbeats`)
- [x] Error taxonomy: kalshi/poly fetch, spread insert, PMCI ingestion, JSON parse
- [x] Real `ingestion_success` SLO backed by heartbeat rolling rate
- [x] `GET /v1/health/observer` endpoint
- [x] Freshness SLA enforcement: `/v1/signals/*` return 503 when stale
- [x] `PMCI_API_KEY` gate on non-health read endpoints
- [x] `.env.example` documents all `PMCI_*` vars

## Phase C — M2M API Readiness (in progress)
- [x] Fix pairsAttempted denominator — true_success_rate backed by pairs_configured
- [x] Rate limiting: @fastify/rate-limit, per-key, configurable via env
- [x] TLS: Caddy reverse proxy config, auto-HTTPS via Let's Encrypt
- [x] /v1/review/* auth-gated, review CLI sends x-pmci-api-key
- [x] X-PMCI-Version response header + api_version in health response bodies
- [x] Per-endpoint request logging (pmci.request_log) + /v1/health/usage endpoint
- [x] Stable API contracts documented (OpenAPI or equivalent) — `docs/openapi.yaml` + `docs/api-reference.md`
- [x] Client SDK / integration guide — `lib/pmci-client.mjs` + `docs/integration-guide.md`
