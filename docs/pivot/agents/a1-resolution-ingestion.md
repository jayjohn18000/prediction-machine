# Agent A1 — Resolution Ingestion

_Read `docs/pivot/north-star.md` and `docs/pivot/dependency-map.md` before starting. You are on the critical path. Everything downstream waits for you._

## Why this work matters

Today, PMCI stores bilateral prices over time but does not know who won. Without settled outcomes, no realized P&L can be computed, and the entire pivot (backtest → go/no-go → live pilot) is blocked. You are producing the single missing data asset that makes the rest of the pivot possible.

This is not a new feature. It is the dataset that proves whether two years of infrastructure investment in this project can produce a dollar.

## What success looks like

- A `market_outcomes` dataset (new table, or a column pair on `provider_markets` — you decide the shape) covering every closed market that belongs to a currently-linked sports family.
- For each closed market: `winning_outcome`, `resolved_at`, `resolution_source_observed`, and enough metadata to trace the ingestion back to the provider response.
- Historical backfill complete for every currently-linked sports family's closed markets, not just new markets going forward.
- A lightweight ongoing job keeps outcomes fresh as new markets settle.
- The data is queryable from the backtest engine (A5) with a single join.

## Why the existing invariant is wrong for this pivot

`prediction-machine/CLAUDE.md` says "Active markets only; no historical/settled market ingestion." That invariant was correct for the old roadmap (live observation of active spreads). It is incorrect for the pivot. Update the invariant explicitly: active markets remain the rule for the observer and proposer, but the new resolution-outcome ingestion path is an intentional exception scoped to linked-family closed markets. Document the exception where the invariant is stated — do not silently break it.

## Scope boundaries

**In scope:**
- Settlement scrapers for Kalshi and Polymarket covering linked-family markets.
- New table / columns for storing outcomes with provider traceability.
- Historical backfill for the ~108 sports families' closed markets.
- A refresh job (daily is fine) for newly-closed markets.

**Out of scope:**
- Outcome ingestion for crypto, economics, or any non-sports category (revisit if/when the pivot expands).
- Outcome ingestion for unlinked markets.
- Any UI on top of the outcome data.
- Reconciling disagreements between Kalshi and Polymarket's recorded outcomes (that belongs to A3).

## What "done" requires you to prove

Before marking this agent complete, you can answer yes to all of the following:

1. For a random sample of 10 currently-linked sports families with at least one closed market on each side, both sides' outcomes are stored and match the provider's public settlement.
2. A single SQL join from `market_links` to `market_outcomes` returns non-null outcomes for both providers on every historically-closed family.
3. The refresh job, run twice in succession, is idempotent — re-running does not create duplicate outcome rows or flip values.
4. The `prediction-machine/CLAUDE.md` invariant text has been updated to document the scoped exception, not silently bypassed.

## Things to escalate to the owner rather than silently handling

- If either provider's public API does not expose settled outcomes for historical markets, say so — do not attempt to infer outcomes from price-at-close. Price-at-close is not ground truth.
- If the scraping strategy requires authentication or rate-limit negotiation beyond what's already in the Kalshi/Polymarket adapters, flag before proceeding.
- If `market_outcomes` needs to live outside `pmci` schema for any reason, ask first.

## What not to do

- Do not scope-expand into "while I'm here, let me also ingest historical active-period metadata." No. Outcomes only.
- Do not touch the observer or proposer. Your work is additive, not modificatory.
- Do not infer outcomes from anything other than the provider's authoritative settlement response.
