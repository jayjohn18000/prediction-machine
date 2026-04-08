# Phase F Gap Analysis — Execution-Readiness Layer

Date: 2026-04-07
Status: Draft
Canonical roadmap reference: `docs/roadmap.md`

## Purpose

This document captures the repository gap analysis for the newly added execution-oriented roadmap phases, with primary focus on **Phase F — Execution-Readiness Layer**.

The goal is to identify what already exists in `prediction-machine`, what is missing, and what needs to be built before PMCI can support a fee-aware relative-value paper-trading workflow.

---

## Executive Summary

PMCI is already strong in the areas that matter upstream:
- market ingestion
- canonicalization
- family/link management
- divergence computation
- freshness and health gating
- machine-facing API discipline

However, the repository is **not yet execution-aware**.

Today, PMCI can answer:
- what markets are structurally linked
- where divergence exists
- whether data freshness is acceptable

It cannot yet answer:
- whether an opportunity survives fees
- whether the opportunity is realistically fillable
- whether the relationship type is safe for early deployment
- whether the edge persists long enough to trade
- whether one venue is operationally superior for routing

That missing middle is the Phase F gap.

---

## Canonical Current-State Surfaces Reviewed

Primary references:
- `docs/roadmap.md`
- `docs/architecture.md`
- `docs/system-state.md`
- `docs/api-reference.md`

Relevant implementation surfaces observed:
- `src/api.mjs`
- `src/routes/signals.mjs`
- `src/routes/families.mjs`
- `src/services/signal-queries.mjs`
- `scripts/checks/check-top-divergences.mjs`
- `scripts/log-divergences.mjs`
- `scripts/refresh-execution-signal-quality.mjs`

---

## Phase F1 — Tradability & Net-Edge Modeling

### What exists now

The repo already contains the structural ingredients needed for tradability logic:
- canonical event and family model
- market links with relationship semantics
- snapshot history for price comparisons
- divergence-oriented query surfaces
- freshness gating and observer health signals

### What is missing

The repo does **not** currently expose a canonical execution-readiness or tradability object.

Missing dimensions include:
- fee estimate
- slippage estimate
- fillability / depth estimate
- lifecycle eligibility for execution
- latency / stale-risk buffer
- net edge after costs
- explicit `tradeable=true|false` gating

### Gap assessment

Severity: **Critical**

This is the core missing layer between PMCI intelligence and execution-aware relative-value trading.

---

## Phase F2 — Execution-Readiness Metrics

### What exists now

Current metrics and signal surfaces include:
- raw divergence
- top divergences
- freshness and projection-ready health
- observer health
- coverage and unmatched market visibility

### What is missing

The following execution-facing metrics do not yet appear to exist as canonical repo outputs:
- fee-adjusted edge
- slippage-adjusted edge
- edge persistence / opportunity half-life
- stale-read rate by family / venue pair
- estimated fillable size
- false-opportunity rate
- consensus price per family
- routing score / best-venue score

### Gap assessment

Severity: **Critical**

Without these metrics, ranked execution decisions will be ad hoc rather than deterministic.

---

## Phase F3 — Execution-Facing API Surface

### What exists now

The active PMCI API already exposes:
- `/v1/market-families`
- `/v1/market-links`
- `/v1/signals/divergence`
- `/v1/signals/top-divergences`
- `/v1/links`
- `/v1/health/*`

These provide the right substrate for execution-intelligence extensions.

### What is missing

The active API does not yet expose the roadmap’s preferred execution-facing machine surfaces such as:
- `/v1/signals/ranked`
- `/v1/router/best-venue`
- execution-readiness detail views per family / venue pair

### Important design constraint

The root `api.mjs` contains legacy execution-intelligence endpoints, but system documentation is explicit that new PMCI route work belongs in the active Fastify API under `src/api.mjs`.

### Gap assessment

Severity: **High**

Execution-aware APIs need to be implemented in the active PMCI surface, not extended via the legacy API.

---

## Phase G — Paper Trader / Shadow Execution

### What exists now

No clear paper trader, synthetic portfolio, or realistic order simulation layer was found in the current repo surfaces reviewed.

### What is missing

Missing capabilities include:
- signal-to-order simulation
- maker/taker simulation
- partial fill and missed fill logic
- synthetic positions / inventory
- expected vs realized edge attribution
- paper PnL and capital utilization accounting

### Gap assessment

Severity: **Greenfield / Total**

This phase should be built as a downstream consumer of PMCI outputs.

---

## Phase H — Guarded Live Pilot

### What exists now

No visible live execution control layer currently exists in the repo.

### What is missing

Missing capabilities include:
- order intent schema
- live venue execution adapters
- reconciliation
- exposure limits
- kill switches
- signal-to-order idempotency
- live expected-vs-realized monitoring

### Gap assessment

Severity: **Greenfield / Total**

The repo is not yet ready for live deployment.

---

## Phase I — Full Execution Layer & Capital Strategy

### What exists now

No portfolio/risk engine or allocator layer is currently visible in the reviewed PMCI repo surfaces.

### What is missing

Missing capabilities include:
- portfolio / risk engine
- allocator logic
- multi-strategy routing
- replay / anomaly monitoring
- venue-pair ranking for deployment optimization

### Gap assessment

Severity: **Greenfield / Total**

This is future platform work beyond the current repo’s execution maturity.

---

## Cross-Cutting Gaps

### 1) No first-class fee model
PMCI cannot be fee-aware until venue/category/order-style fees are modeled explicitly and versioned.

### 2) No first-class slippage / depth model
Raw divergence is not executable edge. A conservative fillability or depth-aware layer is required.

### 3) No execution-readiness contract
Before building APIs, the repo needs canonical data shapes for:
- execution candidate
- tradability score
- routing recommendation
- paper trade event
- expected vs realized edge record

### 4) Legacy execution-intelligence split-brain risk
The repo contains old execution-themed endpoints in root `api.mjs`, while new PMCI work belongs in `src/api.mjs`. This boundary must remain explicit to avoid duplicative logic.

### 5) No persistence model for paper/live execution artifacts
Current PMCI persistence is strong for markets, links, snapshots, and health, but does not yet appear to cover:
- execution candidates
- simulated orders/fills/positions
- live order intents
- live execution records
- risk state

---

## Reusable Existing Components

These current components are directly useful for Phase F implementation:
- `src/routes/signals.mjs`
- `src/services/signal-queries.mjs`
- family/link data model
- review confidence workflow
- freshness gating and health checks
- API versioning discipline
- check-script pattern under `scripts/checks/`

These are likely reusable after reframing:
- legacy execution-intelligence concepts in root `api.mjs`
- divergence logging scripts
- any existing routing/execution-quality scripts or experiments

---

## Recommended Build Order

1. **Phase F1 — Tradability & Net-Edge Modeling**
2. **Phase F2 — Execution-Readiness Metrics**
3. **Phase F3 — Execution-Facing API Surface**
4. **Phase G — Paper Trader / Shadow Execution**
5. **Phase H — Guarded Live Pilot**

This order preserves the architecture boundary that PMCI is the intelligence layer and downstream systems consume its outputs.

---

## Practical Conclusion

The repo is in a strong place to begin Phase F, but it is not yet execution-aware.

The next correct move is **not** live execution. The next correct move is to make PMCI capable of producing deterministic, fee-aware, slippage-aware, structurally valid execution candidates.

Once that exists, a paper trader can be built on top of it with much lower risk and much higher learning value.
