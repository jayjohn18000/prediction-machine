# Phase E1.5 — Sport Inference Fix + Runtime Hardening

> Created: 2026-04-03
> Status: Ready to execute
> Agent roles: Plumbo (code edits via Cursor); Claude Dispatch (orchestration + DB verification only)
> Token strategy: All code changes via Cursor API / Plumbo. Claude Dispatch limited to `curl`, `node -e` DB queries, and file reads.

---

## Overview

The sports ingestion pipeline (`sports-universe.mjs`) has three structural problems discovered during the 2026-04-03 audit:

1. **Polymarket sport inference is broken** — 34,007 Polymarket markets all tagged `sport='unknown'` because the `/sports` endpoint returns numeric tag IDs (e.g. "46") but `inferSportFromPolymarketTags()` tries to match descriptive strings like "tennis". The sport label IS available from the `/sports` response — it's just not being passed through.
2. **Kalshi unknown tickers** — 3,313 Kalshi markets tagged `sport='unknown'` across ~130 series tickers that aren't covered by `sport-inference.mjs` patterns (CS2, lacrosse, NPB, Saudi Pro League, Liga MX, EFL Championship, etc.).
3. **16-hour runtime blocks scheduled re-runs** — The script is one-shot but takes 16+ hours due to nested serial API pagination (1,600 series × events × markets). The lock file means every scheduled trigger is a no-op.

---

## Prerequisites

- Phase E1.4 (Polymarket ingestion fix) is complete ✓
- `lib/ingestion/sports-universe.mjs` exists and runs ✓
- `lib/ingestion/services/sport-inference.mjs` exists ✓
- PID 44322 (stuck/long-running instance) should be killed before testing: `kill 44322 && rm /tmp/pmci-sports-ingest.lock`

---

## Execution Steps

### Step 1: Fix Polymarket sport inference — pass sport label from `/sports` endpoint through to ingestion

**Problem:** `fetchPolymarketSportsTagsFromSportsEndpoint()` extracts the sport label (e.g. "nba", "tennis") from the `/sports` response and stores it as `tag.slug`. But `ingestPolymarketSports()` ignores this label and instead calls `inferSportFromPolymarketTags(tagSlugs)` on the market's own tags — which are numeric IDs that never match.

**Fix:** In `ingestPolymarketSports()`, pass the tag-level sport label as a parameter and use it as the primary sport source. Only fall back to `inferSportFromPolymarketTags()` when the tag label is generic or missing.

In `lib/ingestion/sports-universe.mjs`, find the `ingestPolymarketSports` function. In the outer `for (const tag of sportsTags)` loop, the variable `tagSlug` already holds the sport label from `/sports`. Inside the inner market loop, replace:

```javascript
const tagSlugs = (m?.tags || []).map((t) => t?.slug || t);
const sport = inferSportFromPolymarketTags(tagSlugs);
```

With:

```javascript
// Primary: use the sport label from the /sports endpoint (stored in tagSlug by fetchPolymarketSportsTagsFromSportsEndpoint)
// Fall back to tag-based inference only when tagSlug is generic/missing
const tagSlugs = (m?.tags || []).map((t) => t?.slug || t);
let sport = tagSlug && tagSlug !== 'unknown' && tagSlug !== 'sports'
  ? normalizePolymarketSportLabel(tagSlug)
  : inferSportFromPolymarketTags(tagSlugs);
```

Then add this helper function near the top of the file (after the imports):

```javascript
/**
 * Normalize a Polymarket /sports endpoint sport label to a canonical sport code.
 * The /sports endpoint returns ids like "basketball", "ice-hockey", "american-football"
 * which need mapping to our canonical codes (nba, nhl, nfl, etc.).
 */
function normalizePolymarketSportLabel(label) {
  const l = String(label).toLowerCase().trim();
  const MAP = {
    'american-football': 'nfl',
    'basketball': 'nba',
    'baseball': 'mlb',
    'ice-hockey': 'nhl',
    'ice_hockey': 'nhl',
    'hockey': 'nhl',
    'soccer': 'soccer',
    'football': 'soccer',
    'tennis': 'tennis',
    'golf': 'golf',
    'mma': 'mma',
    'ufc': 'mma',
    'boxing': 'boxing',
    'motorsport': 'motorsport',
    'formula-1': 'f1',
    'f1': 'f1',
    'esports': 'esports',
    'cricket': 'cricket',
    'rugby': 'rugby',
    'nfl': 'nfl',
    'nba': 'nba',
    'mlb': 'mlb',
    'nhl': 'nhl',
    'ncaa': 'ncaa',
    'ncaaf': 'ncaaf',
    'ncaab': 'ncaab',
  };
  return MAP[l] || l; // pass through if not in map — still better than 'unknown'
}
```

**Files affected:** `lib/ingestion/sports-universe.mjs`
**Expected output:** Polymarket markets get sport from the `/sports` endpoint label instead of broken numeric tag matching.
**Cursor prompt hint:** "In sports-universe.mjs, the Polymarket sport inference is broken because inferSportFromPolymarketTags receives numeric tag IDs. Fix it by using the sport label already available in tagSlug from the /sports endpoint. Add a normalizePolymarketSportLabel() helper. See docs/phase-e1-5-sport-inference-and-runtime-plan.md Step 1 for exact code."

---

### Step 2: Expand Kalshi ticker fallback patterns in `sport-inference.mjs`

**Problem:** 3,313 Kalshi markets across ~130 series tickers return `sport='unknown'`. The biggest gaps by count:

| Ticker pattern | Sport | Count | Regex to add |
|---|---|---|---|
| `KXNFLTEAM1POS` | nfl | 288 | `/NFLTEAM/i` |
| `KXCS2MAP`, `KXCS2GAME` | esports | 374 | `/CS2/i` |
| `KXNCAABBGAME`, `KXNCAABBGS` | ncaab | 242 | `/NCAABB/i` |
| `KXMLBF5TOTAL`, `KXMLBF5SPREAD`, `KXMLBGAME`, `KXMLBLSTREAK`, `KXMLBWSTREAK`, `KXMLBAL*`, `KXMLBNL*`, `KXMLBNLCPOTY` | mlb | 341 | `/MLB/i` |
| `KXNBA1HWINNER`, `KXNBAGAME`, `KXNBAPLAYIN` | nba | 105 | `/NBA/i` |
| `KXNHLPLAYOFF` | nhl | 32 | `/NHLPLAY/i` |
| `KXNCAAMLAXGAME`, `KXNCAALAXFINAL`, `KXLAXTEWAARATON` | lacrosse | 142 | `/LAX/i` → 'lacrosse' |
| `KXNPBGAME` | baseball | 46 | `/NPB/i` → 'baseball' |
| `KXKBOGAME` | baseball | 40 | `/KBO/i` → 'baseball' |
| `KXARGPREMDIVGAME` | soccer | 36 | `/ARGPREMDIV/i` |
| `KXSAUDIPLSPREAD`, `KXSAUDIPLTOTAL`, `KXSAUDIPLGAME` | soccer | 99 | `/SAUDIPL/i` |
| `KXEFLCHAMPIONSHIPGAME`, `KXEFLCHAMPIONSHIP`, `KXEFLPROMO` | soccer | 74 | `/EFLCHAMP\|EFLPROMO/i` |
| `KXUSLGAME`, `KXUSL` | soccer | 58 | `/\bUSL/i` |
| `KXLIGAMX*` | soccer | 74 | `/LIGAMX/i` |
| `KXDIMAYORGAME` | soccer | 30 | `/DIMAYOR/i` |
| `KXAHLGAME` | hockey | 32 | `/\bAHL/i` |
| `KXNWSLGAME` | soccer | 24 | `/NWSL/i` |
| `KXMOTOGP*` | motorsport | 33 | `/MOTOGP/i` |
| `KXHEISMAN` | ncaaf | 27 | `/HEISMAN/i` |
| `KXWNBA*` | basketball | 47 | `/WNBA/i` → 'wnba' |
| `KXR6GAME` | esports | 24 | `/R6GAME/i` |
| `KXCHNSLGAME`, `KXCHNSL` | soccer | 40 | `/CHNSL/i` (Chinese Super League) |
| `KXTHAIL1GAME`, `KXTHAIL1` | soccer | 40 | `/THAIL1/i` (Thai League 1) |
| `KXPSLGAME` | soccer | 20 | `/\bPSL/i` (Pakistan Super League cricket or Pro Soccer League — context needed) |
| `KXEUROLEAGUEGAME`, `KXEUROCUPGAME` | basketball | 24 | `/EUROLEAGUE\|EUROCUP/i` |
| `KXKHLGAME` | hockey | 18 | `/\bKHL/i` |
| `KXEKSTRAKLASA*` | soccer | 30 | `/EKSTRAKLASA/i` |
| `KXPERLIGA1` | soccer | 18 | `/PERLIGA/i` (Peruvian Liga 1) |
| `KXBALLERLEAGUEGAME` | soccer | 15 | `/BALLERLEAGUE/i` |
| `KXDARTSMATCH` | darts | 8 | `/DARTS/i` → 'darts' |
| `KXCHESS*` | chess | 21 | `/CHESS/i` → 'chess' |
| `KXDFBPOKAL` | soccer | 4 | `/DFBPOKAL/i` (German cup) |
| `KXCOPPAITALIA` | soccer | 9 | `/COPPAITALIA/i` |
| `KXKNVBCUP` | soccer | 9 | `/KNVBCUP/i` (Dutch cup) |
| `KXCONCACAFCCUPGAME` | soccer | 12 | `/CONCACAF/i` |

**Fix:** Add these patterns to `KALSHI_SERIES_TICKER_FALLBACK` in `lib/ingestion/services/sport-inference.mjs`. Group by sport for readability. Also add new sport codes: `lacrosse`, `wnba`, `darts`, `chess`.

**Files affected:** `lib/ingestion/services/sport-inference.mjs`
**Expected output:** Running the ticker fallback against all 130 unknown series tickers should reduce unknowns from 3,313 to < 200.
**Cursor prompt hint:** "Expand KALSHI_SERIES_TICKER_FALLBACK in sport-inference.mjs with the patterns listed in docs/phase-e1-5-sport-inference-and-runtime-plan.md Step 2. Add entries for CS2, NCAABB, MLB variants, NBA variants, lacrosse, NPB, KBO, WNBA, AHL, KHL, motogp, darts, chess, and ~20 soccer league tickers. Keep the same style as existing entries."

---

### Step 3: Add a broader Kalshi ticker catch-all for MLB/NBA/NFL/NHL prefix fragments

**Problem:** Many unknown tickers contain the league abbreviation but in a position/format the current title-based primary matching misses (e.g. `KXMLBF5TOTAL` — the title is "First 5 Innings Total" which has no "MLB" keyword).

**Fix:** In `KALSHI_SERIES_TICKER_FALLBACK`, add broad prefix catches AFTER all specific entries:

```javascript
// Broad ticker prefix catches — MUST be last in the array
[/^KX.*MLB/i,    'mlb'],
[/^KX.*NBA/i,    'nba'],
[/^KX.*NFL/i,    'nfl'],
[/^KX.*NHL/i,    'nhl'],
[/^KX.*NCAAF/i,  'ncaaf'],
[/^KX.*NCAAB/i,  'ncaab'],
[/^KX.*NCAAM/i,  'ncaab'],
[/^KX.*NCAAW/i,  'ncaab'],  // Women's basketball default
```

**Files affected:** `lib/ingestion/services/sport-inference.mjs`
**Expected output:** Catches tickers like `KXMLBF5TOTAL`, `KXNBA1HWINNER`, `KXNFLTEAM1POS` that contain the league name in the ticker but not in the title.

---

### Step 4: Write unit tests for sport inference

**Problem:** No tests exist for `sport-inference.mjs`. Future pattern additions will risk regressions.

**Fix:** Create `tests/sport-inference.test.mjs` with:
- One test per sport code covering at least the top 3 tickers/titles per sport
- Specific regression tests for the tickers that were previously unknown (from the audit list)
- Tests for `normalizePolymarketSportLabel()`
- Tests for `inferSportFromPolymarketTags()` with both descriptive and numeric tag scenarios

**Files affected:** New file `tests/sport-inference.test.mjs`
**Expected output:** `node --test tests/sport-inference.test.mjs` passes with 0 failures.
**Cursor prompt hint:** "Create tests/sport-inference.test.mjs using Node's built-in test runner. Test inferSportFromKalshiTicker with titles and tickers for all major sports. Include regression tests for previously-unknown tickers: KXCS2MAP, KXNCAABBGAME, KXMLBF5TOTAL, KXNFLTEAM1POS, KXNBA1HWINNER, KXSAUDIPLGAME, KXLIGAMXGAME. Test inferSportFromPolymarketTags with both descriptive slugs and numeric-only slugs."

---

### Step 5: Add max-runtime guard and incremental series skip to `sports-universe.mjs`

**Problem:** The script takes 16+ hours because it re-fetches every series, event, and market on every run — even if nothing changed. The lock file means scheduled triggers get blocked for the duration.

**Fix:** Add two mechanisms:

**5a — Max-runtime guard (hard ceiling):**
```javascript
const MAX_RUNTIME_MS = 30 * 60 * 1000; // 30 minutes
const startTime = Date.now();

function checkTimeout(label) {
  if (Date.now() - startTime > MAX_RUNTIME_MS) {
    console.warn(`[sports-universe] Max runtime exceeded at ${label}. Stopping gracefully.`);
    return true;
  }
  return false;
}
```

Call `checkTimeout()` at the top of each series iteration in `ingestKalshiSports`. If it returns true, break out of the series loop, skip Polymarket (or start it on next run), and let the script exit normally with a partial report.

**5b — Skip recently-seen series (incremental):**
Before fetching events for a series, query `pmci.provider_markets` for the most recent `last_seen_at` where `metadata->>'series_ticker' = $1`. If that timestamp is within the last 6 hours, skip the series entirely. This means a 30-minute window processes ~100-200 series per run, eventually covering all ~1,600 across multiple scheduled runs.

```javascript
async function seriesRecentlySeen(client, seriesTicker, hoursThreshold = 6) {
  const { rows } = await client.query(
    `SELECT MAX(last_seen_at) as latest FROM pmci.provider_markets
     WHERE metadata->>'series_ticker' = $1 AND last_seen_at > NOW() - interval '${hoursThreshold} hours'`,
    [seriesTicker]
  );
  return rows[0]?.latest != null;
}
```

**Files affected:** `lib/ingestion/sports-universe.mjs`
**Expected output:** Script completes in < 30 minutes. Scheduled task runs every 2 hours and covers different series each time. Full coverage in ~16 hours across multiple runs instead of one monolithic run.
**Cursor prompt hint:** "Add a max-runtime guard (30 min) and incremental series skipping to sports-universe.mjs. See docs/phase-e1-5-sport-inference-and-runtime-plan.md Step 5 for the exact implementation pattern. The series skip should query last_seen_at for the series_ticker and skip if seen within 6 hours."

---

### Step 6: Backfill sport codes for existing unknown markets

**Problem:** 34,007 Polymarket + 3,313 Kalshi markets already in DB with `sport='unknown'` need to be updated with correct sport codes.

**Fix:** Create `scripts/ingestion/pmci-backfill-sport-codes.mjs` that:
1. Queries all `category='sports' AND sport='unknown'` rows
2. For Polymarket markets: looks up the tag_id in the `/sports` endpoint mapping and applies `normalizePolymarketSportLabel()`
3. For Kalshi markets: re-runs `inferSportFromKalshiTicker(title, series_ticker)` with the expanded patterns
4. Batch-updates in transactions of 500

Add to `package.json`:
```json
"pmci:backfill:sport-codes": "node scripts/ingestion/pmci-backfill-sport-codes.mjs"
```

**Files affected:** New file `scripts/ingestion/pmci-backfill-sport-codes.mjs`, `package.json`
**Expected output:** Running `npm run pmci:backfill:sport-codes` reduces unknown count from ~37K to < 500.
**Cursor prompt hint:** "Create scripts/ingestion/pmci-backfill-sport-codes.mjs — a one-shot script that updates sport codes for existing unknown sports markets. For Polymarket: fetch /sports endpoint, build tagId→sportLabel map, update based on metadata->>'tag_id'. For Kalshi: re-run inferSportFromKalshiTicker(title, metadata->>'series_ticker') with expanded patterns. Batch UPDATE in groups of 500."

---

### Step 7: Update scheduled task interval

**Problem:** Current scheduled task runs but gets blocked by the 16-hour lock. With the 30-minute max-runtime, the task should run every 2 hours.

**Fix:** Claude Dispatch will update the scheduled task interval via `update_scheduled_task` to run every 2 hours instead of the current cadence.

**Handled by:** Claude Dispatch (not Plumbo)
**Expected output:** Scheduled task runs 12x/day, each covering a different subset of series.

---

### Step 8: Kill stale process and run verification

**Handled by:** Claude Dispatch

```bash
# Kill the stuck 16-hour process
kill 44322 && rm /tmp/pmci-sports-ingest.lock

# Run the fixed ingestion
npm run pmci:ingest:sports

# Run backfill
npm run pmci:backfill:sport-codes

# Verify unknown count dropped
node --input-type=module -e "
import('./src/platform/db.mjs').then(async ({createClient}) => {
  const c = createClient();
  await c.connect();
  const r = await c.query(\"SELECT sport, COUNT(*) as n FROM pmci.provider_markets WHERE category='sports' AND sport='unknown' GROUP BY sport\");
  console.log('Remaining unknowns:', JSON.stringify(r.rows));
  const total = await c.query(\"SELECT COUNT(*) as n FROM pmci.provider_markets WHERE category='sports' AND sport='unknown'\");
  console.log('Total unknown:', total.rows[0].n);
  await c.end();
});
"

# Standard verification
npm run pmci:smoke
npm run verify:schema
```

---

## Verification

Phase E1.5 is complete when:

- [ ] `node --test tests/sport-inference.test.mjs` passes
- [ ] Polymarket sports markets have real sport codes (not all 'unknown')
- [ ] Kalshi unknown count < 200 (from 3,313)
- [ ] `npm run pmci:ingest:sports` completes in < 30 minutes
- [ ] Scheduled task runs without lock-file conflicts
- [ ] `npm run pmci:smoke` passes
- [ ] `npm run verify:schema` passes

---

## Rollback

- Sport inference changes are additive (new patterns). Removing them restores prior behavior (more unknowns but no data loss).
- The backfill script only changes `sport` column values from `'unknown'` to inferred codes. To rollback: `UPDATE pmci.provider_markets SET sport = 'unknown' WHERE category = 'sports' AND sport != 'unknown'`.
- The max-runtime guard can be disabled by setting `MAX_RUNTIME_MS` to a very high value.

---

## Execution Order for Plumbo

Steps 1-6 are code changes — send to Plumbo via Cursor API in this order:

1. **Step 1** (Polymarket inference fix) — highest impact, fixes 34K markets
2. **Step 2 + 3** (Kalshi ticker patterns) — can be done together, fixes 3K markets
3. **Step 4** (tests) — do right after pattern changes while they're fresh
4. **Step 5** (runtime guard) — independent of inference fixes
5. **Step 6** (backfill script) — depends on Steps 1-3 being merged

Steps 7-8 are orchestration — Claude Dispatch handles directly.
