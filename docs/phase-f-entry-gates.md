# Phase F — Entry gates (moat-preserving)

Canonical gap analysis: [`docs/phase-f-gap-analysis.md`](phase-f-gap-analysis.md)  
Roadmap: [`docs/roadmap.md`](roadmap.md) Phase F

## Purpose

Phase F adds **execution-readiness** (fees, slippage, tradability) on top of PMCI’s intelligence graph. Starting broad “rank everything” workflows before the substrate is ready would erode auditability and produce non-reproducible execution metrics.

## Hard gates (all required before Phase F implementation work)

1. **Multi-vertical linked coverage** — At least **two** material verticals (e.g. sports + economics, or crypto + politics nominees) have accepted cross-venue links at the volume and semantic quality bar defined in the active phase plan, not merely raw ingestion counts.
2. **Bilateral freshness SLOs** — Observer frontier pairs show Kalshi + Polymarket snapshots within the freshness window assumed by `/v1/health/*` and operator SLOs (no systematic stale leg on linked markets).
3. **Versioned tradability assumptions** — Fee/slippage/latency inputs are explicit, versioned, and checked into repo (see `config/tradability-model.v1.example.json`). No silent defaults in application code for net-edge math.
4. **Schema + smoke gates** — `npm run verify:schema` and `npm run pmci:smoke` pass on the target deployment revision.
5. **Audit packet discipline** — Category-specific audit scripts (politics, sports, economics, crypto as applicable) run clean at the semantic violation budget agreed for that category.

## Soft gates (strongly recommended)

- `PMCI_SWEEP_PRIORITIZE_LINKED=1` in environments where snapshot capacity is constrained, so unlinked stale rows do not starve linked markets.
- Observer frontier cap (`OBSERVER_MAX_PAIRS_PER_CYCLE`) tuned so provider rate limits remain stable.

## Versioning

When F1 tradability logic ships, bump the `version` field in the active tradability config and document the change in `docs/decision-log.md`.
