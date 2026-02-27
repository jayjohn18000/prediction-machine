# Roadmap (Infrastructure-First)

## Phase A — Baseline Stability (active)
- [x] Schema validation gate
- [x] Smoke checks + coverage checks
- [x] SLO health endpoint (`/v1/health/slo`)
- [ ] Ingestion retry telemetry and failure budget tracking

## Phase B — Reliability Hardening
- [ ] Structured ingestion retries/backoff metrics
- [ ] Error taxonomy + alertable counters
- [ ] Freshness SLA enforcement policies

## Phase C — M2M API Readiness
- [ ] Stable API contracts for canonical events/markets/prices
- [ ] Versioned response guarantees
- [ ] Revenue telemetry hooks for endpoint usage + conversion signals
