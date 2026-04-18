# ADR: Ladder divergence scoring (Phase F)

## Status
Proposed — gate for Phase F work on execution-facing signals.

## Context
`top-divergences` uses a single YES-mid consensus per **family** (`src/services/signal-queries.mjs`). Ladder families expose a **distribution** across many strikes, not one binary mid.

## Decision (to confirm)
Define a distribution-level score (examples: Earth-mover / Wasserstein distance on implied densities, max absolute edge per strike, binned KL on histograms, or “worst strike” divergence). Binary YES spread remains valid for single-outcome families.

## Consequences
Drives API shape for ladder-aware signals and caching.
