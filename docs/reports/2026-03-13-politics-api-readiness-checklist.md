# Politics API Readiness Checklist — 2026-03-13

## Scope
Pilot-readiness verification for politics after semantic remediation closeout.

## Route Contract Clarification

The PMCI service implements routes under **`/v1/*`** (see `src/routes/*`).
If an external gateway exposes **`/api/v1/*`**, that must be treated as an explicit prefix alias at the gateway layer.

**Canonical service examples (repo-native):**
- `GET /v1/markets?topic=politics&linked=true`
- `GET /v1/signals/top-divergences?topic=politics`
- `GET /v1/health/projection-ready`

## Contract Checklist

- [x] **Linked politics markets endpoint**
  - Contract (service): `GET /v1/markets?topic=politics&linked=true`
  - Data state: **139 active clean linked rows** post-cleanup.

- [x] **Politics spread/signal endpoint**
  - Contract (service): `GET /v1/signals/top-divergences?topic=politics`
  - Behavior: returns cross-provider opportunities over linked politics pairs.

- [x] **Latest strict audit artifact**
  - Artifact path: `docs/reports/latest-politics-audit-packet.json`
  - Behavior: strict packet includes coverage, integrity warnings, and link counters.

## Acceptance Snapshot
- Semantic residual violations: **0**
- Governor/president guard classes blocked: **party↔yes/no**, **nominee/primary↔general**, **runoff↔general**
- D6 governor threshold remains below 0.20 and is treated as follow-on coverage/business tuning.

## Final Sign-off
**POLITICS PHASE COMPLETE: semantic integrity gates are green and service-level API paths are internally consistent.**
