# prediction-machine

For system architecture see `docs/architecture.md`.

## Overview

`prediction-machine` is the PMCI backend: an observation-only prediction-market intelligence system that ingests data from providers, normalizes it into canonical PMCI structures, and exposes machine-facing API endpoints for health, coverage, links, families, review, and signals.

## Quickstart

1. Copy env and fill in credentials:
   ```bash
   cp .env.example .env
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Apply database migrations:
   ```bash
   npx supabase login
   npx supabase link --project-ref awueugxrdlolzjzikero
   npx supabase db push
   ```
4. Start the observer or API:
   ```bash
   npm run start
   npm run api:pmci
   ```

## Common Commands

- Start observer loop:
  ```bash
  npm run start
  ```
- Start PMCI API:
  ```bash
  npm run api:pmci
  ```
- PMCI smoke check:
  ```bash
  npm run pmci:smoke
  ```
- PMCI probe:
  ```bash
  npm run pmci:probe
  ```
- Verify schema:
  ```bash
  npm run verify:schema
  ```
- Coverage endpoint check:
  ```bash
  npm run pmci:check-coverage
  ```

## Docs

- Architecture: `docs/architecture.md`
- Current system state: `docs/system-state.md`
- Decision log: `docs/decision-log.md`
- Roadmap: `docs/roadmap.md`
- API reference: `docs/api-reference.md`
- OpenAPI spec: `docs/openapi.yaml`
