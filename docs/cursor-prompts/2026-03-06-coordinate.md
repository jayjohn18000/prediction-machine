# Cursor Prompt: PMCI Normalization — Coordinated Implementation (Phases D0–D7)
> Generated: 2026-03-06
> Agents: @Codebase @Terminal

---

## Context

You are implementing the PMCI (Prediction Market Canonical Intelligence) normalization improvements
for a Kalshi ↔ Polymarket spread observer system. The full design is in:

  `docs/cursor-prompts/2026-03-06-openclaw-audit-6section.md`

Read that file first. This prompt coordinates the implementation across all phases. Work through
the phases in order. Each phase has a hard gate — do not proceed to the next until it passes.

---

## Repository State (as of 2026-03-06)

- Branch: `chore/infra-hardening-baseline-2026-02-26`
- Key files to read before editing:
  - `lib/ingestion/universe.mjs` — universe ingest (Kalshi + Polymarket)
  - `lib/matching/proposal-engine.mjs` — proposal generation and scoring
  - `scripts/pmci-ingest-politics-universe.mjs` — CLI entry for universe ingest
  - `scripts/pmci-propose-links-politics.mjs` — CLI entry for proposal engine
  - `.env.example` — env var reference (never read `.env` directly)
  - `supabase/migrations/` — schema migrations (read before any schema change)

---

## Phase D0 — Series Activity Audit

**Goal:** Determine which of the currently configured Kalshi series are actually live, without
relying on any external overlap table.

### Task D0.1 — Create `scripts/pmci-audit-series-activity.mjs`

The script should:
1. Read `PMCI_POLITICS_KALSHI_SERIES_TICKERS` from env (comma-separated list)
2. For each ticker, call `GET /trade-api/v2/events?series_ticker={ticker}&status=open`
   (use the existing Kalshi client pattern from `lib/providers/kalshi.mjs`)
3. Print a table: `ticker | event_count | status`
4. At the end, print a summary: `N live / M total configured`

Add to `package.json` scripts:
```
"pmci:audit:series": "node scripts/pmci-audit-series-activity.mjs"
```

**Hard gate D0:** Script runs without error. Summary prints.

---

## Phase D1 — Series Discovery

**Goal:** Build a mechanism to find Kalshi series that are not currently in config.

### Task D1.1 — Create `scripts/pmci-discover-kalshi-series.mjs`

**Option A (preferred):** Call the Kalshi series list endpoint if it exists:
```
GET /trade-api/v2/series?category=politics&status=active
```
If that endpoint doesn't exist or returns 404, fall back to Option B.

**Option B (heuristic):** Generate candidate tickers by cross-joining:
- State codes: all 50 US state 2-letter codes
- Race types: `GOVPARTY`, `SENATE`, `PRES`, `HOUSE`, `AG`
- Years: current year through current year + 3
- Probe each via `GET /events?series_ticker={ticker}&status=open`
- Rate-limit to 2 req/sec; cache results to a JSON file at `KALSHI_DISCOVERY_CACHE_PATH`

Output: print `PMCI_POLITICS_KALSHI_SERIES_TICKERS=<discovered,tickers>` to stdout for human
review + manual env update. Do not auto-write to `.env`.

Add to `package.json`:
```
"pmci:discover:series": "node scripts/pmci-discover-kalshi-series.mjs"
```

**Hard gate D1:** Discovery script runs. At least 2 `GOVPARTY-*` or `SENATE-*` tickers appear
in discovered output.

---

## Phase D2 — Per-Series Budget in universe.mjs

**Goal:** Fix the global event cap bias so early series don't exhaust the budget.

### Task D2.1 — Edit `lib/ingestion/universe.mjs`

Find the Kalshi ingest loop (around line 207). Replace the global `while (report.eventsVisited < maxEvents)` pattern with per-series budgeting:

```js
// After building the active series list:
const activeSeries = configured.filter(ticker => seriesEventCount[ticker] > 0);
const perSeriesBudget = Math.ceil(maxEvents / Math.max(activeSeries.length, 1));

for (const ticker of activeSeries) {
  let seriesVisited = 0;
  // inner pagination loop, break when seriesVisited >= perSeriesBudget
}
```

The total across all series should still not exceed `maxEvents` (enforce a global counter as
a safety ceiling).

**Hard gate D2:** After a test ingest run, the coverage dashboard query (below) shows no single
series prefix accounting for >60% of new markets ingested:

```sql
SELECT
  split_part(external_id, '-', 1) AS prefix,
  COUNT(*) AS ingested
FROM pmci.provider_markets
WHERE provider = 'kalshi'
  AND created_at > NOW() - INTERVAL '1 hour'
GROUP BY 1 ORDER BY 2 DESC;
```

---

## Phase D3 — State Code Expansion + Topic Signature Patterns

**Goal:** Make `GOVPARTY-OH-2026-REP` and `"ohio governor 2026"` produce the same topic
signature key. This eliminates the primary source of topic-blocking false rejects.

### Task D3.1 — Add state code expansion to `lib/matching/proposal-engine.mjs`

Add a `STATE_CODES` map (all 50 states) near the top of the file. Add an `expandSeriesTokens`
function that splits a Kalshi ticker on `-` and replaces 2-letter tokens with full state names.
Call this during topic signature derivation for Kalshi markets.

### Task D3.2 — Add GOVPARTY and SENATE topic signature patterns

In `TOPIC_KEY_PATTERNS`, add:

```js
// Governor races — Kalshi ticker format
{ re: /^govparty-([a-z]{2})-(\d{4})/i,
  key: (m) => `gov_${STATE_CODES[m[1].toLowerCase()] || m[1]}_${m[2]}` },
// Governor races — Polymarket title format
{ re: /\bgov(ernor)?\b.{0,40}\b([a-z]{2}|[a-z ]{4,20})\b.{0,20}\b(20\d{2})\b/i,
  key: (m) => `gov_${expandState(m[2])}_${m[3]}` },
// Senate races — both formats
{ re: /^senate?-([a-z]{2})-(\d{4})/i,
  key: (m) => `senate_${STATE_CODES[m[1].toLowerCase()] || m[1]}_${m[2]}` },
{ re: /\bsenate?\b.{0,40}\b([a-z]{2}|[a-z ]{4,20})\b.{0,20}\b(20\d{2})\b/i,
  key: (m) => `senate_${expandState(m[1])}_${m[2]}` },
```

**Hard gate D3:** Unit test (write inline in the script or as `test/matching/topic-sig.test.mjs`):
```js
assert(topicSignature('GOVPARTY-OH-2026-REP') === topicSignature('ohio governor republican 2026'))
assert(topicSignature('SENATE-TX-2026') === topicSignature('texas senate race 2026'))
```
Both assertions must pass.

---

## Phase D4 — Synonym Normalization

**Goal:** Prevent `GOP / Republican` and `Dem / Democratic` mismatches from triggering false
entity gate rejections.

### Task D4.1 — Add `normalizeTitle()` to `lib/matching/proposal-engine.mjs`

```js
const SYNONYM_MAP = {
  'gop': 'republican', 'dem': 'democratic', 'democrat': 'democratic',
  'democrats': 'democratic', 'republicans': 'republican', 'gop\'s': 'republican',
  'pm': 'prime minister', 'sen': 'senator', 'gov': 'governor',
  'rep': 'representative', 'pres': 'president',
  'atty': 'attorney', 'ag': 'attorney general',
};

function normalizeTitle(title) {
  return title.toLowerCase().replace(/\b(\w+)\b/g, w => SYNONYM_MAP[w] ?? w);
}
```

Apply `normalizeTitle()` to both titles **before** tokenization and before the entity gate check.

### Task D4.2 — Soften the entity gate

Change the entity gate from a hard reject to a soft confidence penalty:

```js
const entityScore = computeEntityOverlap(normalizedA, normalizedB);
if (entityScore === 0) {
  confidence *= 0.4; // penalty — most false pairs will fall below threshold
  if (confidence < MIN_CONFIDENCE_THRESHOLD) return null;
} else {
  confidence += entityScore * 0.3;
}
```

**Hard gate D4:** Query your rejected proposals — the count of rejections where `kalshi_title`
contains `gop` or `dem` and `rejection_reason = 'entity_gate'` should be 0 after re-running
the proposer on existing data.

```sql
SELECT COUNT(*) FROM pmci.proposed_links
WHERE status = 'rejected'
  AND rejection_reason = 'entity_gate'
  AND (lower(kalshi_title) LIKE '%gop%' OR lower(kalshi_title) LIKE '%dem%');
```

---

## Phase D5 — Integrity Guards (Safety Rails)

**Goal:** Add two specific guards that prevent known failure modes.

### Task D5.1 — Guard: poly_only mislabeling

Add to `scripts/pmci-probe.mjs` (or create a new `scripts/pmci-integrity-check.mjs`):

```sql
-- Warn if a canonical_event is labeled poly_only but has orphaned kalshi markets
SELECT ce.id, ce.title, COUNT(pm.id) AS orphaned_kalshi
FROM pmci.canonical_events ce
CROSS JOIN pmci.provider_markets pm
WHERE ce.source_annotation = 'poly_only'
  AND pm.provider = 'kalshi' AND pm.status = 'active'
  AND similarity(lower(ce.title), lower(pm.title)) > 0.4
  AND NOT EXISTS (
    SELECT 1 FROM pmci.market_links ml
    JOIN pmci.market_families mf ON mf.id = ml.family_id
    WHERE mf.canonical_event_id = ce.id
      AND (ml.primary_market_id = pm.id OR ml.secondary_market_id = pm.id)
  )
GROUP BY ce.id, ce.title
HAVING COUNT(pm.id) > 0;
```

If any rows are returned, print `WARN: poly_only event has orphaned kalshi markets` and exit
with a non-zero status code.

### Task D5.2 — Guard: bulk inactivation with live data

Before any `UPDATE pmci.provider_markets SET status = 'inactive' WHERE ...` runs (whether
from a script or interactive SQL), there should be a pre-check function available:

```js
// lib/guards/inactive-guard.mjs
export async function checkBeforeInactivate(db, marketIds) {
  const { rows } = await db.query(`
    SELECT pm.id, COUNT(DISTINCT pms.id) AS snapshots, COUNT(DISTINCT ml.id) AS links
    FROM pmci.provider_markets pm
    LEFT JOIN pmci.provider_market_snapshots pms ON pms.provider_market_id = pm.id
    LEFT JOIN pmci.market_links ml
      ON ml.primary_market_id = pm.id OR ml.secondary_market_id = pm.id
    WHERE pm.id = ANY($1)
    GROUP BY pm.id
    HAVING COUNT(DISTINCT pms.id) > 0 OR COUNT(DISTINCT ml.id) > 0
  `, [marketIds]);
  if (rows.length > 0) {
    throw new Error(`Cannot inactivate ${rows.length} markets — they have live snapshots or links. Review: ${rows.map(r => r.id).join(', ')}`);
  }
}
```

**Hard gate D5:** Both guards can be invoked from `npm run pmci:probe` (or a new
`npm run pmci:integrity`) without error.

---

## Phase D6 — Coverage Validation

**Goal:** Verify that the pipeline improvements are producing measurable link coverage gains,
using only your own DB queries.

### Task D6.1 — Add coverage dashboard to `scripts/pmci-probe.mjs`

After existing probe output, print the link coverage by topic:

```sql
SELECT
  CASE
    WHEN pm.external_id ILIKE 'GOVPARTY%' OR pm.title ILIKE '%governor%' THEN 'governor'
    WHEN pm.external_id ILIKE 'SENATE%' OR pm.title ILIKE '%senate%' THEN 'senate'
    WHEN pm.external_id ILIKE 'PRES%' OR pm.title ILIKE '%president%' THEN 'president'
    ELSE 'other'
  END AS topic,
  pm.provider,
  COUNT(DISTINCT pm.id) AS total,
  COUNT(DISTINCT ml.id) AS linked,
  ROUND(COUNT(DISTINCT ml.id)::numeric / NULLIF(COUNT(DISTINCT pm.id), 0), 3) AS link_rate
FROM pmci.provider_markets pm
LEFT JOIN pmci.market_links ml
  ON ml.primary_market_id = pm.id OR ml.secondary_market_id = pm.id
WHERE pm.status = 'active'
GROUP BY 1, 2 ORDER BY 1, 2;
```

**Hard gate D6:** `link_rate` for `governor` and `senate` topics is ≥ 0.20 (20%). If it is
below this threshold, the earlier phases did not improve ingestion coverage — return to D0/D1.

---

## Phase D7 — Event Typing (Structural Schema for Election Phases)

**Goal:** Add `election_phase` and `subject_type` to `provider_markets` so that primary-vs-general
mismatches can be detected and prevented from linking.

### Task D7.1 — Migration

Create `supabase/migrations/20260307000002_provider_market_event_typing.sql`:

```sql
ALTER TABLE pmci.provider_markets
  ADD COLUMN IF NOT EXISTS election_phase text
    CHECK (election_phase IN ('primary', 'general', 'runoff', 'special', 'unknown')),
  ADD COLUMN IF NOT EXISTS subject_type text
    CHECK (subject_type IN ('candidate', 'party', 'policy', 'appointment', 'unknown'));

COMMENT ON COLUMN pmci.provider_markets.election_phase IS
  'Election phase: primary, general, runoff, special. NULL = not yet classified.';
COMMENT ON COLUMN pmci.provider_markets.subject_type IS
  'What the market resolves on: candidate, party, policy, appointment.';
```

Run: `npx supabase db push`, then `npm run verify:schema`.

### Task D7.2 — Populate during ingestion

In `lib/ingestion/universe.mjs`, after building each market object, derive and set these fields:

```js
// Derive election_phase from ticker/title
function inferElectionPhase(ticker, title) {
  if (/primary/i.test(title) || /-PRI-/i.test(ticker)) return 'primary';
  if (/runoff/i.test(title)) return 'runoff';
  if (/special/i.test(title)) return 'special';
  return 'general'; // default for race markets
}

// Derive subject_type from ticker structure
function inferSubjectType(ticker, title) {
  if (/^GOVPARTY|^SENATE.*-REP$|^SENATE.*-DEM$/i.test(ticker)) return 'party';
  if (/nominate|appointment|appoint/i.test(title)) return 'appointment';
  if (/policy|rate|decision|bill|act\b/i.test(title)) return 'policy';
  return 'candidate';
}
```

**Hard gate D7:** `SELECT COUNT(*) FROM pmci.provider_markets WHERE election_phase IS NULL AND status = 'active'` returns 0 after a universe ingest run.

---

## Verification Sequence (run in order after all phases)

```bash
npm run pmci:audit:series        # D0: all configured series respond
npm run pmci:discover:series     # D1: new GOVPARTY/SENATE tickers found
npm run pmci:ingest:politics:universe  # D2: ingest with per-series budget
npm run pmci:probe               # D3/D5/D6: topic sig, integrity checks, coverage
npm run pmci:propose:politics    # D4: proposer with synonyms + soft entity gate
npm run pmci:review              # review any new proposals
npm run verify:schema            # D7: confirm election_phase/subject_type columns exist
```

---

## Files to read before editing (in order)

1. `lib/ingestion/universe.mjs` — understand current loop structure before D2
2. `lib/matching/proposal-engine.mjs` — understand TOPIC_KEY_PATTERNS before D3/D4
3. `lib/providers/kalshi.mjs` — understand API client before D0/D1
4. `supabase/migrations/` — read latest migration before D7
5. `scripts/pmci-probe.mjs` — understand current probe output before D5/D6

---

## Do NOT do

- Do not auto-write to `.env` — only print proposed env changes to stdout
- Do not bulk-inactivate any markets without running the inactive-guard check first
- Do not anchor on "81 pairs" or any Openclaw overlap count as a target — use your own DB queries
- Do not skip `npm run verify:schema` after any migration
- Do not change the `providerMarketRef = slug#outcomeName` format — it is already correct
