# Phase E1 — Sports Expansion Plan

**Status:** Planning (not started)
**Entry criteria:** Phase D semantic closeout complete ✓ (2026-03-13)
**Goal:** Ingest and cross-link sports prediction markets from Kalshi and Polymarket using the same guard-first proposer + strict-audit loop validated in Phase D.

---

## Strategic Context

The PMCI infrastructure is category-agnostic. The `canonical_events.category` column, all API query params (`?category=sports`), and adapter `inferCategory()` stubs are already wired. What does not yet exist: sports-specific discovery scripts, canonical event seeds, an adapted proposal engine, and lifecycle policies for short-lived game markets.

Sports markets differ from politics in two important ways:

1. **Event lifetime** — Game-level markets open and settle within 24–48 hours. Season/championship markets last weeks to months. The canonical event lifecycle must handle both.
2. **Entity model** — Politics matches on candidate names. Sports matches on team names, league abbreviations, and event dates. The proposal engine needs a new entity layer.

The recommended rollout is **narrow-first**: start with championship/season-long markets (e.g., "Who wins Super Bowl LX?") which are structurally similar to politics markets, before tackling individual game markets. This gives the system a chance to validate the pipeline with lower-volume, longer-lived events.

---

## Rollout Phases

### E1.0 — Pre-work & Audit (no code changes)

**Goal:** Understand what sports markets already exist in the DB and on each provider before writing any ingestion code.

**Steps:**

1. **Audit existing provider_markets for sports**
   Run a quick DB query to check if any rows in `pmci.provider_markets` have `category = 'sports'` already (some may have slipped through `inferCategory()`).
   ```sql
   SELECT provider_id, count(*) FROM pmci.provider_markets
   WHERE category = 'sports' GROUP BY provider_id;
   ```

2. **Kalshi sports series discovery — manual probe**
   Hit the Kalshi API directly to enumerate sports series tickers. Two approaches:
   - Option A (preferred): `GET /series?category=sports` — returns all sports series in one call if the endpoint accepts a `sports` category filter.
   - Option B (fallback): `GET /series?category=Basketball`, `?category=Football`, `?category=Baseball` etc. — Kalshi may use sport-specific category names rather than a single `sports` umbrella.

   Known Kalshi sports series patterns (to probe):
   - NFL: `NFLWINS`, `NFL`, `NFLCHAMP`, `SUPERBOWL`
   - NBA: `NBA`, `NBACHAMP`, `NBAWIN`
   - MLB: `MLB`, `MLBWINNER`, `WORLDSERIES`
   - NHL: `NHL`, `STANLEYCUP`
   - Golf: `PGA`, `MASTERS`
   - Soccer: `MLS`, `UEFA`

   Record all discovered tickers + their Kalshi `category` field values.

3. **Polymarket sports tag discovery — manual probe**
   Hit the Polymarket CLOB API: `GET /events?tag_slug=sports&limit=100` or enumerate known tag IDs. Identify the numeric tag IDs for each sport (basketball, football, baseball, hockey, soccer, etc.).

   Known Polymarket tag slug patterns to try:
   - `sports`, `nfl`, `nba`, `mlb`, `nhl`, `soccer`, `tennis`, `golf`

4. **Record findings in `config/pmci-sports-discovery-notes.json`** — a scratchpad JSON mapping Kalshi series tickers and Polymarket tag IDs to sport/league. This feeds Step E1.2.

**Acceptance gate E1.0:** At least 3 Kalshi sports series tickers and at least 1 Polymarket sports tag ID confirmed live.

---

### E1.1 — Schema & Lifecycle Decisions

**Goal:** Lock down the data model for sports before writing any code. See `docs/phase-e1-sports-schema.md` for full design.

**Steps:**

1. **Define `sport` and `league` metadata fields** in `canonical_events.metadata` JSONB (no migration needed — metadata is already JSONB).
   ```json
   {
     "sport": "football",
     "league": "nfl",
     "season": "2025-2026",
     "event_type": "championship"
   }
   ```

2. **Define two canonical event classes:**
   - `championship` — long-lived (weeks/months), maps to "Who wins [league] championship?"
   - `game` — short-lived (hours/days), maps to a single scheduled game

3. **Define lifecycle policy for closed game markets:**
   - **Option A (recommended for v1):** Set `status = 'closed'` on canonical_event when all linked provider_markets are settled/expired. Do not delete. Closed events are excluded from default API queries but remain for historical analysis.
   - **Option B:** Hard-delete closed game canonical events after 30 days. Simpler, but loses history.

   **Decision: Option A.** Consistent with existing `status = 'removed'` precedent in market_links. Add a `pmci:sports:archive-closed` script later (not a blocker for E1).

4. **Confirm `inferCategory()` subcategory plan** — replace the single `subcategory: 'game'` stub with sport-specific subcategories: `football`, `basketball`, `baseball`, `hockey`, `soccer`, `golf`, `other_sports`. See `lib/providers/kalshi-adapter.mjs` and `lib/providers/polymarket-adapter.mjs`.

**Acceptance gate E1.1:** Schema design doc reviewed and approved (no DB migration required for v1; all sports metadata in JSONB).

---

### E1.2 — Discovery Scripts

**Goal:** Write scripts that automatically discover and emit sports series/tag configs, mirroring the politics discovery pattern.

**Files to create:**

**`scripts/discovery/pmci-discover-kalshi-sports-series.mjs`**
Mirrors `pmci-discover-kalshi-politics-series.mjs`. Key changes:
- Try `GET /series?category=sports` first (Option A)
- Fallback (Option B): probe known sport-specific Kalshi category names (`Basketball`, `Football`, `Baseball`, `Hockey`) and collect series tickers
- Validate: require at least 1 series with open events before emitting config
- Output: `PMCI_SPORTS_KALSHI_SERIES_TICKERS=...` to stdout (for human review before writing `.env`)

**`scripts/discovery/pmci-discover-polymarket-sports-tags.mjs`**
New script (no politics equivalent). Kalshi uses series tickers; Polymarket uses tag IDs.
- Enumerate known Polymarket tag slugs (`sports`, `nfl`, `nba`, `mlb`, `nhl`, `soccer`)
- Call `GET /events?tag_slug={slug}&limit=1` to validate each tag returns live markets
- Output: `PMCI_SPORTS_POLY_TAG_IDS=...` to stdout

**Environment variables to add to `.env.example`:**
```
# Sports ingestion
PMCI_SPORTS_KALSHI_SERIES_TICKERS=        # comma-separated Kalshi series tickers for sports
PMCI_SPORTS_POLY_TAG_IDS=                 # comma-separated Polymarket tag IDs for sports
PMCI_SPORTS_MAX_EVENTS_PER_PROVIDER=200   # guard against runaway ingestion
PMCI_SPORTS_INCLUDE_GAME_MARKETS=false    # start false; enable after championship validation
```

**Acceptance gate E1.2:** Both discovery scripts run without errors and emit at least one valid series/tag. Output manually reviewed before any `.env` changes.

---

### E1.3 — Adapter & Ingestion Updates

**Goal:** Update the ingestion pipeline to correctly tag and ingest sports markets.

**Files to modify:**

**`lib/providers/kalshi-adapter.mjs`** — `inferCategory()`
Replace stub:
```js
// Before:
if (raw.includes('sport')) {
  return { category: 'sports', subcategory: 'game' };
}

// After: map Kalshi category names to sport subcategories
const KALSHI_SPORT_SUBCATEGORIES = {
  'basketball': 'basketball', 'nba': 'basketball',
  'football': 'football', 'nfl': 'football',
  'baseball': 'baseball', 'mlb': 'baseball',
  'hockey': 'hockey', 'nhl': 'hockey',
  'soccer': 'soccer', 'mls': 'soccer',
  'golf': 'golf', 'pga': 'golf',
  'tennis': 'tennis',
};
// Match raw category against KALSHI_SPORT_SUBCATEGORIES keys
```

**`lib/providers/polymarket-adapter.mjs`** — `inferCategory()`
Same subcategory mapping. Polymarket uses tag names rather than a `category` field, so check `event.tags` array for sport tag slugs.

**`lib/ingestion/universe.mjs`** (or equivalent sweep file)
Add sports series config reading:
```js
const sportsSeries = (process.env.PMCI_SPORTS_KALSHI_SERIES_TICKERS || '').split(',').filter(Boolean);
const sportsPolyTagIds = (process.env.PMCI_SPORTS_POLY_TAG_IDS || '').split(',').filter(Boolean);
```

Gate game-level market ingestion behind `PMCI_SPORTS_INCLUDE_GAME_MARKETS=false` for the initial rollout. Championship/season markets only in v1.

**`lib/ingestion/pmci-sweep.mjs`** (or PMCI sweep script)
Add guard: when sports markets are ingested, enforce `PMCI_SPORTS_MAX_EVENTS_PER_PROVIDER` to prevent an accidental full-universe sports sweep from overwhelming the DB.

**Acceptance gate E1.3:** Observer ingestion run with sports series config shows > 0 sports `provider_markets` rows in DB with `category = 'sports'`, and zero increase in politics market count (isolation check).

---

### E1.4 — Canonical Event Seeding

**Goal:** Create canonical sports events in the DB to serve as the normalized reference layer, mirroring `seed-canonical-from-config.mjs` for politics.

**Files to create:**

**`config/pmci-sports-series.json`**
Static config seeding initial sports canonical events. Start narrow:
```json
{
  "version": "1",
  "events": [
    {
      "slug": "nfl-super-bowl-lx-winner",
      "title": "Super Bowl LX Winner",
      "category": "sports",
      "subcategory": "football",
      "metadata": { "sport": "football", "league": "nfl", "season": "2025-2026", "event_type": "championship" }
    },
    {
      "slug": "nba-championship-2026-winner",
      "title": "NBA Championship 2026 Winner",
      "category": "sports",
      "subcategory": "basketball",
      "metadata": { "sport": "basketball", "league": "nba", "season": "2025-2026", "event_type": "championship" }
    }
  ]
}
```

**`scripts/seed/seed-sports-canonical.mjs`**
New seeding script. Mirrors `seed-canonical-from-config.mjs` but reads from `config/pmci-sports-series.json`. For each entry:
1. Upsert into `pmci.canonical_events` (slug as unique key)
2. Create a default market family per event (e.g., "Winner market")
3. Log created vs. skipped

**Acceptance gate E1.4:** `node scripts/seed/seed-sports-canonical.mjs` runs cleanly, canonical events visible via `GET /v1/canonical-events?category=sports`.

---

### E1.5 — Sports Proposal Engine

**Goal:** Extend (or create a sports-specific version of) the proposal engine to cross-link Kalshi and Polymarket sports markets.

**Key differences from politics proposal engine:**

| Concern | Politics | Sports |
|---------|---------|--------|
| Entity type | Candidate name (person) | Team name + league |
| Title format | "Will X win the DEM nomination?" | "Will [Team] win [Championship]?" or "[Team A] vs [Team B]" |
| Blocking strategy | Topic key (governor, senate, nominee) | Sport + league + season |
| Date sensitivity | Year-level | Game date (±1 day for game markets) |
| Fuzzy name variants | Last name matching, initials | Team nickname aliases (e.g., "Chiefs" = "Kansas City Chiefs") |
| Proxy detection | Geography + race type | Same sport + correlated but not identical event |

**Files to create:**

**`lib/matching/sports-entity-parse.mjs`**
New entity parser for sports. Key exports:
- `parseSportsTitle(title)` → `{ league, team1, team2, eventType, season }` — extracts structured fields from a sports market title
- `normalizeSportsTeamName(name)` → canonical team name — e.g., `"KC Chiefs"` → `"kansas city chiefs"`, `"Golden State"` → `"golden state warriors"`
- `SPORTS_TEAM_ALIASES` — dictionary mapping common abbreviations/nicknames to full team names for NFL, NBA, MLB, NHL

**`lib/matching/sports-proposal-engine.mjs`**
New proposal engine (do not modify the politics engine). Key design:
- Same guard-first architecture as politics engine
- Blocking: group candidate pairs by `(sport, league, season)` — prevents cross-sport false positives
- Scoring: use title token overlap + team name overlap (via `SPORTS_TEAM_ALIASES`) + date overlap
- Championship markets: higher confidence threshold (0.88, same as politics)
- Game markets (when enabled): require exact date match ± 1 day + both team names present
- Output: insert into `pmci.proposed_links` with `category='sports'`
- Guard: reject any pair where sport/league differs

**`scripts/review/pmci-sports-review.mjs`**
Sports-specific review CLI. Mirrors `scripts/review/` patterns for politics. Accepts `--category=sports` flag.

**Acceptance gate E1.5:** Proposer + reviewer loop completes with ≥ 1 accepted cross-platform sports link. Strict audit (`scripts/audit/`) shows zero semantic violations.

---

### E1.6 — Dashboard & API Verification

**Goal:** Verify the existing API and dashboard work correctly for sports; make targeted fixes where needed.

**API checks (all should work without code changes — verify):**
- `GET /v1/canonical-events?category=sports` → returns seeded sports events
- `GET /v1/markets/unlinked?category=sports` → returns sports-only unlinked markets
- `GET /v1/market-families?event_id=<sports-uuid>` → returns sports families
- `GET /v1/signals/top-divergences?event_id=<sports-uuid>` → returns divergences for sports event
- `GET /v1/coverage/summary?category=sports` → returns sports-only coverage stats (this endpoint needs a `category` filter guard — see Known Risks in `system-state.md`)

**Dashboard updates (pmci-dashboard):**
- Add `Sports` to the event category selector (currently only `Politics` is shown)
- Verify sparkline charts render correctly for sports divergence data
- No structural changes needed — the dashboard is already category-aware via API

**Acceptance gate E1.6:** At least one sports canonical event with active cross-platform links is visible in the dashboard, and top-divergences signal is non-empty.

---

## Sequencing Summary

```
E1.0  Audit + manual API probing (no code)       ~1–2 hrs
E1.1  Schema & lifecycle decisions (doc only)    ~1 hr
E1.2  Discovery scripts                          ~2–3 hrs
E1.3  Adapter + ingestion updates               ~2–3 hrs
E1.4  Canonical event seeding                   ~1–2 hrs
E1.5  Sports proposal engine                    ~4–6 hrs
E1.6  Dashboard + API verification              ~1 hr
```

Total estimated effort: **12–18 hours** of focused implementation.

---

## Guarded Rollout Policy

Follow the same guard-first policy used in Phase D:

1. **Start narrow:** Championship/season markets only (`PMCI_SPORTS_INCLUDE_GAME_MARKETS=false`). Validate the full pipeline before enabling game-level markets.
2. **Isolation:** Sports ingestion must not affect existing politics `provider_markets` count. Run isolation checks after each ingestion sweep.
3. **Semantic integrity gate:** Do not accept any sports link proposals until `scripts/audit/` strict-audit passes with zero violations for sports.
4. **Coverage threshold:** Target ≥ 2 accepted cross-platform sports links before declaring E1.5 complete.
5. **SLO monitoring:** Observer SLOs (`ingestion_success`, `freshness_lag`, `api_p95_latency`) must remain green throughout. Sports is additive — it should not degrade politics SLOs.

---

## Known Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Kalshi doesn't offer a `?category=sports` filter | Medium | Use sport-specific category names or heuristic series ticker probing (Option B in E1.2) |
| Polymarket sports tag IDs change or are undocumented | Medium | Cache discovered tag IDs; re-probe on each observer cycle |
| Championship markets have very different title formats across providers | High | Build `SPORTS_TEAM_ALIASES` dict early; start with well-known leagues (NFL, NBA) only |
| Game-level markets cause DB size explosion (100s of markets/day) | High | Keep `PMCI_SPORTS_INCLUDE_GAME_MARKETS=false` until championship pipeline is validated; add explicit row budget guard |
| Sports markets may already be partially ingested under `category='unknown'` | Low-Medium | Run E1.0 audit first; re-categorize any existing unknown rows if needed |
| `coverage/summary` endpoint double-counts across categories (known risk from system-state.md) | Low | Add `?category=sports` filter enforcement in `src/routes/coverage.mjs` before sports goes live |

---

## Files Created/Modified Checklist

### New files
- [ ] `docs/phase-e1-sports-plan.md` (this file)
- [ ] `docs/phase-e1-sports-schema.md`
- [ ] `config/pmci-sports-series.json`
- [ ] `scripts/discovery/pmci-discover-kalshi-sports-series.mjs`
- [ ] `scripts/discovery/pmci-discover-polymarket-sports-tags.mjs`
- [ ] `scripts/seed/seed-sports-canonical.mjs`
- [ ] `lib/matching/sports-entity-parse.mjs`
- [ ] `lib/matching/sports-proposal-engine.mjs`
- [ ] `scripts/review/pmci-sports-review.mjs`

### Modified files
- [ ] `lib/providers/kalshi-adapter.mjs` — `inferCategory()` sports subcategories
- [ ] `lib/providers/polymarket-adapter.mjs` — `inferCategory()` sports subcategories
- [ ] `lib/ingestion/universe.mjs` (or sweep) — sports env var wiring
- [ ] `lib/ingestion/pmci-sweep.mjs` — sports max-events guard
- [ ] `src/routes/coverage.mjs` — enforce `?category` filter guard
- [ ] `.env.example` — add `PMCI_SPORTS_*` vars
- [ ] `docs/roadmap.md` — update E1 checklist as items complete
- [ ] `docs/system-state.md` — add sports status entry
- [ ] `pmci-dashboard/main.js` — add Sports to category selector
