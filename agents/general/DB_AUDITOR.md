# DB_AUDITOR

## Trigger
Fire when any task hits a DB or query error:
- `ECONNREFUSED` or connection timeout
- `relation does not exist` / `column does not exist`
- Syntax error in SQL
- Constraint violation (unique, FK, not-null)
- Orphan rows or out-of-range values detected

## Scope
**In scope:**
- DB data quality issues
- Connection errors
- Orphan rows (e.g. market_links referencing missing provider_markets)
- Out-of-range or invalid values in snapshot data
- Duplicate constraint violations

**Out of scope:**
- Schema migrations (→ `agents/general/MIGRATION_AGENT.md`)
- Provider API errors (→ `agents/general/API_DEBUGGER.md`)

## Pre-flight
```bash
node scripts/db-audit.mjs
```
Capture full output. Note any FAIL lines.

## Files to read
- `scripts/db-audit.mjs` — audit script logic and checks
- `src/db.mjs` — DB client setup and query helpers
- `src/platform/env.mjs` — env var validation (DATABASE_URL)

## Execution mode

### Step 1 — Diagnose
Run pre-flight and identify the error class:
1. Connection error → check `DATABASE_URL` is set, Supabase project is active
2. Relation/column not found → escalate to `MIGRATION_AGENT`
3. Data quality issue → continue with Step 2

### Step 2 — Inspect affected rows
Query the relevant table to find bad rows. Examples:
```sql
-- Orphan market_links
SELECT * FROM pmci.market_links
WHERE provider_market_id NOT IN (SELECT id FROM pmci.provider_markets);

-- Snapshots with invalid prices
SELECT * FROM pmci.provider_market_snapshots
WHERE yes_price < 0 OR yes_price > 1;
```

### Step 3 — Produce output
**Option A — Data fix (no code change needed):**
Write the corrective SQL as a sanity checklist item with:
- Root cause description
- SQL to reproduce the issue
- SQL to fix it
- Rollback SQL if destructive

**Option B — Code fix (query/connection logic):**
Produce a PR plan:
- Files to touch
- Diff outline (specific changes)
- Test assertion

## Output format
```
## DB Audit Report

**Error class:** <connection | orphan | constraint | range | other>
**Root cause:** <1–2 sentences>

### Evidence
<SQL query + result>

### Fix
<SQL or code diff>

### Verification
Re-run: `node scripts/db-audit.mjs` → exit 0
```

## Verification
```bash
node scripts/db-audit.mjs
# Must exit 0 with no FAIL lines
```
