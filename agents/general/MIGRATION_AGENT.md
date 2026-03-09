# MIGRATION_AGENT

## Trigger
Fire when:
- `relation "pmci.X" does not exist` / `column "X" does not exist`
- `view "v_market_links_current" does not exist`
- `npx supabase db push` fails
- `npm run verify:schema` exits non-zero
- Schema drift detected (expected table/column missing after deploy)

## Scope
**In scope:**
- Missing tables, columns, views in `pmci.*` schema
- Failed or partially-applied migrations
- Schema drift between code expectations and live DB
- Writing new migration SQL files

**Out of scope:**
- Data quality issues within existing tables (→ `agents/general/DB_AUDITOR.md`)
- Provider API errors (→ `agents/general/API_DEBUGGER.md`)

## Pre-flight
```bash
npm run verify:schema
npx supabase db push --dry-run
```
Capture output. Note which table/column/view is missing.

## Files to read
- `scripts/verify-pmci-schema.mjs` — expected schema contract
- `supabase/migrations/` — list all files, read the latest 2–3

## Execution mode

### Step 1 — Identify the drift
Run pre-flight. From `verify:schema` output, extract:
- Missing object type (table / column / view)
- Object name
- Schema (`pmci` vs `public`)

### Step 2 — Find the owning migration
```bash
ls -lt supabase/migrations/
```
Find the migration that should have created the missing object. Read it. Check if it was applied (`supabase migration list`).

### Step 3 — Produce migration

**If migration exists but wasn't applied:**
```bash
npx supabase db push
npm run verify:schema
```

**If migration is missing (new object needed):**
Create a new migration file:
- Filename: `supabase/migrations/YYYYMMDDHHMMSS_<description>.sql`
- Use `CREATE TABLE IF NOT EXISTS` / `CREATE OR REPLACE VIEW`
- Include `GRANT SELECT ON ... TO anon, authenticated` for views

Output the full migration SQL in the plan.

### Step 4 — Apply and verify
```bash
npx supabase db push
npm run verify:schema   # Must exit 0
```

## Output format
```
## Migration Plan

**Missing object:** <schema.name> (<type>)
**Root cause:** <migration missing | not applied | typo>

### Migration file
**Path:** supabase/migrations/<timestamp>_<name>.sql

```sql
<full migration SQL>
```

### Apply
```bash
npx supabase db push
npm run verify:schema
```
```

## Verification
```bash
npm run verify:schema
# Must exit 0 — all tables, columns, and v_market_links_current view present
```
