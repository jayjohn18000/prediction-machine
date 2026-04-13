# OpenClaw Execution Prompt: Fix pmci.pmci_runtime_status Schema Drift
> Generated: 2026-04-10
> Branch: main

## PMCI Invariants
[PMCI invariants: no .env writes; run verify:schema after migrations;
new routes in src/api.mjs only; inactive-guard before bulk market changes;
never skip npm run verify:schema]

## Situation Summary
The observer is throwing a recurring error on every cycle because it queries/writes to `pmci.pmci_runtime_status`, a table that does not exist in the database. This is a live blocker — the observer cannot complete its loop cleanly until the table is created. The migration needs to match exactly what the observer expects to insert/upsert.

## Tasks

### Track A — Create the migration (critical path)

- A1: Read `/Users/jaylenjohnson/prediction-machine/observer.mjs` and find **all** references to `pmci_runtime_status` — capture every column name, data type hint, and the shape of any INSERT/UPSERT/SELECT against it.
- A2: Create migration file at `supabase/migrations/20260410000001_pmci_runtime_status.sql` (or `.mjs` if the project uses JS migrations — check an existing migration file for the naming convention). The migration must:
  - Create `pmci.pmci_runtime_status` table
  - Include all columns observed in A1 with appropriate PostgreSQL types
  - Include a primary key
  - Include `created_at` / `updated_at` timestamps if the observer writes them
- A3: Run `npm run verify:schema` in `~/prediction-machine`. Hard gate: exits 0 with no errors.

### Track B — Confirm observer no longer errors (run after A3)

- B1: Run `npm run pmci:smoke` and return the full output. Hard gate: no `pmci_runtime_status` errors in output.

## Verification sequence (return full output to Claude)
```
npm run verify:schema
npm run pmci:smoke
```

## Reference files (Plumbo reads these — do not rely on Claude's summaries)
- `/Users/jaylenjohnson/prediction-machine/observer.mjs`
- `/Users/jaylenjohnson/prediction-machine/supabase/migrations/` (check one recent file for migration format/convention)
- `/Users/jaylenjohnson/prediction-machine/docs/system-state.md`
