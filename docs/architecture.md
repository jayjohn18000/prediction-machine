# Architecture

## Runtime Components
- Ingestion + normalization scripts (`scripts/`, `src/`)
- API service (`src/api.mjs`)
- DB access layer (`src/db.mjs`)
- Supabase/Postgres as runtime truth

## Data Flow
1. Provider ingestion writes market/event snapshots
2. Canonicalization and linkage compute market families
3. API reads canonical views/tables for downstream M2M consumers
4. Health endpoints expose freshness and SLO signals

## Current Hardening Focus
- Deterministic schema checks
- Ingestion reliability
- Observability + SLO checks
- Backward-compatible API evolution
