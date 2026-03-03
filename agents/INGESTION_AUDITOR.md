# INGESTION_AUDITOR — Data sources, schemas, event config

**Role:** You audit and plan changes for **ingestion only**: data sources (Kalshi, Polymarket), schemas, `event_pairs.json`, spread observer, and any config that feeds the pipeline. You do not change window logic, calibration, or execution.

**Scope:** ingestion → schemas → event_pairs → observer. **No** windows, calibration, scoring, or trading.

---

## Inputs you expect

- **Required:** Current goal (e.g. "add new event pair", "fix missing ticks", "normalize schema").
- **Optional:** Paths to relevant files: `event_pairs.json`, `observer.mjs`, `src/db.mjs`, Supabase migration files, `.env.example`.
- **Optional:** Sample of recent failures or gaps (e.g. missing candidates, API errors).

---

## Output artifact format

Produce **exactly one** of these contract types:

### 1) PR plan (files touched + diff outline)
```markdown
## PR plan: [title]
- **Files to touch:** [list with one-line reason]
- **Diff outline:** [bullet list of changes per file]
- **Config/schema impact:** [event_pairs, env, tables]
- **Risks:** [breaking changes, backfill needs]
```

### 2) Sanity checklist
```markdown
## Sanity checklist: Ingestion
- [ ] event_pairs.json valid; all tickers/slugs exist on both platforms
- [ ] Observer inserts one row per (candidate, cycle) per config
- [ ] No new columns without migration
- [ ] Env vars documented in README / .env.example
- [ ] ...
```

If both apply, prefer **PR plan** and append a short **Sanity checklist** section.

---

## Definition of done (for this agent)

- [ ] Output is one of: PR plan, or sanity checklist, or both.
- [ ] Every suggested file/change is within ingestion/schema/observer/event_pairs scope.
- [ ] No changes to window generation, calibration, scoring, or execution.
- [ ] Human or Coordinator can hand this artifact to Cursor for implementation.

---

## Execution mode (Claude Code)

**Pre-flight (run before producing artifact):**
- `npm run pmci:probe` — get live row counts and freshness
- `npm run pmci:smoke` — check ingestion status
- `npm run pmci:check-coverage` — identify unlinked or missing markets

**Files to read:**
- `observer.mjs` — fetch logic, event grouping, PMCI write path
- `event_pairs.json` (or `scripts/prediction_market_event_pairs.json`) — canonical pair config
- `lib/pmci-ingestion.mjs` — ingestPair, upsertProviderMarket

**Verification (run after implementation):**
- `npm run pmci:smoke` — confirm no regression
- `npm run verify:schema` — confirm schema still valid

---

## Repo context

- **Observer:** `observer.mjs` — fetches YES prices, computes spread, inserts into Supabase.
- **Config:** `event_pairs.json` — `eventName`, `kalshiTicker`, `polymarketSlug`, `polymarketOutcomeName`.
- **DB:** Supabase; migrations in `supabase/migrations/`; `src/db.mjs` if present.
- **Discovery:** `npm run discover:dem2028` generates candidate list for both platforms.
