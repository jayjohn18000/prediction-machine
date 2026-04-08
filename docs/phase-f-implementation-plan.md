# Phase F Implementation Plan — Execution-Readiness Layer

Date: 2026-04-07
Status: Draft
Canonical roadmap reference: `docs/roadmap.md`
Related analysis: `docs/phase-f-gap-analysis.md`

## Purpose

This document turns the roadmap’s new **Phase F — Execution-Readiness Layer** into an implementation-oriented build plan.

The design principle is explicit:

- **PMCI remains the intelligence / canonicalization layer**
- A downstream execution service will eventually own:
  - order placement
  - fills
  - inventory
  - capital allocation
  - live trading risk

Phase F therefore focuses on making PMCI capable of producing **deterministic, fee-aware, structurally valid execution candidates**.

---

## Goals

By the end of Phase F, PMCI should be able to answer:

1. Is this linked family / venue pair structurally valid for early relative-value deployment?
2. Is the data fresh enough and the market lifecycle appropriate?
3. Does the opportunity survive fees, slippage, and stale-risk buffers?
4. What is the net executable edge?
5. Is this candidate ranked highly enough to hand to a paper trader?

---

## Scope

Phase F covers three implementation tracks:

- **F1 — Tradability & Net-Edge Modeling**
- **F2 — Execution-Readiness Metrics**
- **F3 — Execution-Facing API Surface**

It does **not** include live order placement.

---

# F1 — Tradability & Net-Edge Modeling

## Outcome

Introduce a canonical **execution candidate / tradability model** for each family and venue pair.

## Proposed core object

```json
{
  "family_id": 123,
  "event_id": "uuid",
  "providers": ["kalshi", "polymarket"],
  "relationship_type": "equivalent",
  "mapping_confidence": 0.96,
  "freshness_ok": true,
  "lifecycle_ok": true,
  "raw_divergence_bps": 420,
  "consensus_price": 0.51,
  "liquidity_score": 0.62,
  "estimated_fillable_size": 250,
  "estimated_fee_bps": 110,
  "estimated_slippage_bps": 95,
  "latency_risk_bps": 40,
  "net_edge_bps": 175,
  "tradeable": true,
  "reasons": ["fresh", "high_confidence_link", "net_edge_above_threshold"]
}
```

## Proposed modules to add

### New services
- `src/services/tradability-service.mjs`
- `src/services/fee-model-service.mjs`
- `src/services/slippage-model-service.mjs`
- `src/services/router-service.mjs`

### Likely updates
- `src/services/signal-queries.mjs`
- `src/routes/signals.mjs`
- `docs/api-reference.md`
- `docs/openapi.yaml`

## Responsibilities by service

### `fee-model-service.mjs`
Owns:
- fee lookup by venue / category / order style
- normalization of fee assumptions into basis points
- versioning of fee assumptions

### `slippage-model-service.mjs`
Owns:
- conservative fillability estimate
- slippage estimate from available market data
- fallback heuristics when direct depth data is unavailable

### `tradability-service.mjs`
Owns:
- construction of the execution candidate object
- application of thresholds and gating rules
- calculation of `tradeable=true|false`
- net edge computation after all modeled costs

### `router-service.mjs`
Owns:
- best-venue / venue-pair ranking logic
- routing score or best-executable-path recommendation
- tie-break logic when multiple comparable opportunities exist

---

## Proposed config / schema additions

## Option A — config-first (recommended for first pass)
Add versioned config under repo control for:
- fee assumptions by venue / category / order style
- minimum thresholds by relationship type
- stale-risk buffers
- default slippage heuristics

Suggested path:
- `config/execution-readiness.json`

## Option B — DB-backed later
If the model becomes dynamic enough, promote assumptions into PMCI tables.

Suggested future tables:
- `pmci.execution_fee_models`
- `pmci.execution_thresholds`
- `pmci.execution_candidate_snapshots`

Recommendation: start config-first, migrate to DB only if necessary.

---

## Initial gating rules (v1)

For early relative-value deployment, require:
- `relationship_type IN ('identical', 'equivalent')`
- mapping confidence above threshold
- freshness pass
- market lifecycle pass
- net edge above minimum threshold
- estimated fillable size above minimum threshold

Explicitly exclude in v1:
- `proxy`
- `correlated`
- stale markets
- markets near invalid lifecycle states

---

# F2 — Execution-Readiness Metrics

## Outcome

Introduce deterministic, versioned metrics that turn execution-readiness into stable machine-facing primitives.

## Metrics to implement first

### 1) `fee_adjusted_edge_bps`
Formula:
- raw divergence minus estimated fees

### 2) `slippage_adjusted_edge_bps`
Formula:
- fee-adjusted edge minus estimated slippage

### 3) `net_edge_bps`
Formula:
- slippage-adjusted edge minus latency/stale-risk buffer

### 4) `estimated_fillable_size`
Estimated executable size under conservative assumptions

### 5) `consensus_price`
Canonical family-level reference price across linked legs

### 6) `routing_score`
Relative ranking score for venue-pair deployment quality

### 7) `edge_half_life_seconds`
How quickly a candidate’s edge decays below threshold

### 8) `false_opportunity_rate`
How often candidates that clear thresholds fail to sustain net edge under later analysis

## Proposed implementation surfaces

### New / updated services
- extend `src/services/signal-queries.mjs`
- possibly add `src/services/execution-metrics-service.mjs`

### Scripts/checks to add
- `scripts/checks/pmci-check-ranked-signals.mjs`
- `scripts/checks/pmci-check-tradability.mjs`
- `scripts/checks/pmci-check-routing-score.mjs`

### Docs to update
- `docs/api-reference.md`
- `docs/openapi.yaml`
- optional: `docs/execution-metrics-spec.md`

---

# F3 — Execution-Facing API Surface

## Outcome

Expose ranked and machine-consumable execution-readiness outputs from the active PMCI API.

## Routes to add

### 1) `GET /v1/signals/ranked`
Purpose:
- ranked execution candidates by category, event, family, or provider pair

Suggested response shape:
```json
{
  "filters": {"category": "sports"},
  "count": 10,
  "results": [
    {
      "family_id": 123,
      "relationship_type": "equivalent",
      "net_edge_bps": 175,
      "tradeable": true,
      "routing_score": 0.81,
      "estimated_fillable_size": 250
    }
  ]
}
```

### 2) `GET /v1/router/best-venue`
Purpose:
- return best venue-side / venue-pair recommendation for a family

### 3) Optional: `GET /v1/signals/tradability`
Purpose:
- detailed execution-candidate view for debugging and operator review

## Files to modify
- `src/api.mjs`
- `src/routes/signals.mjs`
- add `src/routes/router.mjs`
- service wiring in `src/server.mjs` if needed
- `docs/api-reference.md`
- `docs/openapi.yaml`

## Important architecture rule

Do **not** add new PMCI execution-facing routes to root `api.mjs`.
The active surface is `src/api.mjs`.

---

# Proposed Build Sequence

## Step 1 — Define contracts first
Before writing the services, define:
- execution candidate shape
- routing recommendation shape
- metric definitions and formulas
- threshold config shape

### Deliverables
- this plan
- optional `docs/execution-metrics-spec.md`
- optional `docs/execution-candidate-schema.md`

## Step 2 — Build config-first fee/slippage models
Implement initial assumptions in code/config, not full database machinery.

### Deliverables
- `config/execution-readiness.json`
- `src/services/fee-model-service.mjs`
- `src/services/slippage-model-service.mjs`

## Step 3 — Build tradability service
Construct canonical execution candidate objects.

### Deliverables
- `src/services/tradability-service.mjs`
- tests or check scripts validating representative families

## Step 4 — Build ranked/routing services and API routes
Expose the outputs in machine-facing form.

### Deliverables
- `GET /v1/signals/ranked`
- `GET /v1/router/best-venue`
- updated OpenAPI and API reference docs

## Step 5 — Add checks and regression protections
Ensure outputs are deterministic and stable.

### Deliverables
- tradability smoke check
- ranked-signal check
- routing-score check

---

# Suggested File Changes Summary

## New files
- `docs/phase-f-gap-analysis.md`
- `docs/phase-f-implementation-plan.md`
- `config/execution-readiness.json`
- `src/services/fee-model-service.mjs`
- `src/services/slippage-model-service.mjs`
- `src/services/tradability-service.mjs`
- `src/services/router-service.mjs`
- `src/routes/router.mjs`
- `scripts/checks/pmci-check-tradability.mjs`
- `scripts/checks/pmci-check-ranked-signals.mjs`
- `scripts/checks/pmci-check-routing-score.mjs`

## Existing files likely to modify
- `src/api.mjs`
- `src/routes/signals.mjs`
- `src/services/signal-queries.mjs`
- `docs/api-reference.md`
- `docs/openapi.yaml`
- possibly `package.json` scripts

---

# Acceptance Criteria

Phase F should be considered implemented when:

1. PMCI can produce deterministic execution candidates for structurally linked families
2. Candidates include fee/slippage/stale-risk-aware net edge
3. Ranked machine-facing endpoints exist in the active PMCI API
4. Execution-readiness outputs are documented and versioned
5. Check scripts exist to validate tradability and ranking behavior
6. Outputs are strong enough to power a downstream paper trader without relying on ad hoc logic

---

# Risks and Guardrails

## Risks
- mixing execution-readiness logic into legacy root API
- making fee/slippage logic opaque or hand-wavy
- overfitting routing logic before enough sports/crypto data exists
- letting proxy/correlated links into the first tradable universe

## Guardrails
- keep PMCI as intelligence layer only
- use config-first assumptions with explicit versioning
- make every threshold reviewable
- keep v1 restricted to `identical` / `equivalent` family types
- require deterministic checks before paper-trader handoff

---

# Next Step After Phase F

The direct follow-on is **Phase G — Paper Trader / Shadow Execution**.

That system should consume the outputs from `/v1/signals/ranked` and related execution-readiness surfaces rather than reconstructing tradability logic independently.

That separation will keep PMCI clean and make paper/live execution much easier to reason about.
