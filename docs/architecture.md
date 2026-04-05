# Architecture

## Overview

`prediction-machine` is the backend intelligence layer for PMCI (Prediction Market Canonical Intelligence). It ingests and normalizes data from multiple prediction-market providers, stores canonical runtime state in Supabase/Postgres, and exposes a machine-facing API for health, coverage, review, links, families, and signals.

`lovable-ui` is the frontend presentation layer. It consumes the PMCI API for dashboards, system health, coverage visibility, family exploration, and divergence views. It should not contain PMCI matching or ingestion logic.

Supabase/Postgres is the shared persistence layer for provider markets, snapshots, canonical events, families, links, proposals, and operational health state.

## System Structure

```text
Kalshi API ─┐
            ├─ prediction-machine ingestion + matching + PMCI API
Polymarket ─┘
                    │
                    ▼
              Supabase / Postgres
                    │
                    ├─ pmci canonical tables
                    ├─ snapshots / links / families
                    └─ health + audit state
                    │
                    ▼
              lovable-ui frontend
                    │
                    ▼
              Human operators / agents
```

## Component Roles

### prediction-machine
Responsibilities:
- provider ingestion
- spread observation
- PMCI normalization
- proposal and linking logic
- machine-facing API surface (`/v1/*`)
- health, coverage, review, and signals endpoints

Key active entrypoints:
- `observer.mjs` — observer loop
- `src/api.mjs` — active PMCI API entrypoint
- `src/server.mjs` — server bootstrap, auth, CORS, freshness, route registration

Important internal areas:
- `lib/providers/` — provider clients and adapters
- `lib/ingestion/` — ingestion and universe sweep logic
- `lib/matching/` — proposal generation, scoring, and entity parsing
- `src/routes/` — PMCI API routes
- `supabase/migrations/` — canonical schema history

### lovable-ui
Responsibilities:
- dashboard visualization
- system health and status views
- coverage, unlinked-market, and new-market visibility
- top divergences and family exploration
- operator-facing PMCI monitoring

Integration rule:
- `lovable-ui` consumes backend API contracts from `prediction-machine`
- PMCI business logic stays in `prediction-machine`

### Supabase / Postgres
Responsibilities:
- runtime persistence for PMCI tables
- historical snapshots and links
- canonical event and family model
- operational persistence for observer heartbeats, request logs, and audit state

## Core Data Flow

1. Provider APIs expose raw markets, events, and price data.
2. `prediction-machine` ingests provider data and normalizes it into PMCI tables.
3. Matching and review flows create canonical events, families, and links.
4. The PMCI API serves normalized read models and operational health endpoints.
5. `lovable-ui` consumes those endpoints for operator and dashboard views.

## PMCI Data Model

Primary tables:
- `pmci.provider_markets` — one row per market per provider
- `pmci.provider_market_snapshots` — observed price snapshots over time
- `pmci.canonical_events` — normalized canonical event records
- `pmci.market_families` — groups of equivalent or related markets
- `pmci.market_links` — provider market to family memberships
- `pmci.proposed_links` — review queue for candidate pairings
- `pmci.observer_heartbeats` — observer liveness state

## Architecture Boundaries

Keep these boundaries sharp:
- backend logic belongs in `prediction-machine`
- UI logic belongs in `lovable-ui`
- Supabase is the shared persistence layer
- `src/api.mjs` is the active PMCI API entrypoint
- root `api.mjs` is legacy and should not receive new PMCI route work

## Operating Principles

- `prediction-machine` is the source of truth for ingestion, matching, API behavior, and PMCI logic.
- `lovable-ui` is the source of truth for frontend/dashboard behavior.
- Health, coverage, review, and signal endpoints should remain stable machine-facing contracts.
- New categories should follow the same guard-first, strict-audit pattern already established in PMCI.

## Canonical References

For current live state and rationale, see:
- `docs/system-state.md`
- `docs/decision-log.md`
- `docs/roadmap.md`
