# Phase E1.4 — Polymarket Sports Ingestion Fix

**Status:** Ready to execute
**Entry criteria:** Phase E1.2 sports ingestion schema complete ✓; E1.3 proposer hardening complete
**Goal:** Fix `lib/ingestion/sports-universe.mjs` so Polymarket sports markets are actually ingested. Currently 0 Polymarket sports markets exist in the DB despite 9,953 Kalshi sports markets.

---

## Overview

Deep research (2026-04-01) identified two root causes for zero Polymarket sports market ingestion:

**Root cause 1 — Invalid API parameter:** The current code passes `active=true` as a query parameter to the Polymarket Gamma API. This is NOT a valid parameter. The Gamma API either ignores it or treats it as a filter condition that can't be satisfied, resulting in empty responses.

**Root cause 2 — Suboptimal tag discovery:** The current code fetches ALL Polymarket tags (thousands) and keyword-filters them. The correct approach is to use the dedicated `/sports` endpoint which returns authoritative sport→tag_id mappings directly.

**Fix:** Remove `active=true`, add `archived=false`, and add a `/sports`-first tag discovery path.

---

## Prerequisites

- `lib/ingestion/sports-universe.mjs` exists (Phase E1.2 ✓)
- `POLYMARKET_BASE = "https://gamma-api.polymarket.com"` is already set in the file
- The existing Kalshi ingestion code (in same file) is working correctly — do not touch it

---

## Execution Steps

### Step 1: Fix the Polymarket market-fetch URL parameters

File: `lib/ingestion/sports-universe.mjs`

Locate `ingestPolymarketSports` → the inner fetch loop where `/markets` is called. Find this block:

```javascript
url.searchParams.set("active", "true");
url.searchParams.set("closed", "false");
```

Replace with:

```javascript
url.searchParams.set("closed", "false");
url.searchParams.set("archived", "false");
// NOTE: DO NOT set active=true — not a valid Gamma API parameter
```

**Files affected:** `lib/ingestion/sports-universe.mjs`
**Expected output:** Markets endpoint now returns actual results instead of empty arrays.

---

### Step 2: Add `/sports` endpoint as primary tag discovery path

File: `lib/ingestion/sports-universe.mjs`

Add a new function `fetchPolymarketSportsTagsFromSportsEndpoint()` that calls `/sports` first:

```javascript
/**
 * Fetch sports tag IDs from the dedicated /sports endpoint.
 * Returns array of { sportId, tagIds: string[] } — where tagIds are 
 * the comma-separated numeric IDs from the sports metadata response.
 * Falls back to keyword-based tag search if /sports returns empty.
 */
async function fetchPolymarketSportsTagsFromSportsEndpoint() {
  try {
    const url = `${POLYMARKET_BASE}/sports`;
    const data = await fetchJson(url);
    const sports = Array.isArray(data) ? data : [];
    
    if (sports.length === 0) {
      console.log('[sports-universe] /sports endpoint returned empty; falling back to tag keyword search');
      return null; // signals fallback
    }

    // Flatten to unique tag IDs with sport label
    const tagMap = new Map(); // tagId -> sportLabel
    for (const s of sports) {
      const sportLabel = String(s.id || s.slug || s.sport_id || '');
      const rawTags = String(s.tags || '');
      for (const id of rawTags.split(',').map(t => t.trim()).filter(Boolean)) {
        tagMap.set(id, sportLabel);
      }
    }

    const result = [...tagMap.entries()].map(([tagId, sportLabel]) => ({
      id: tagId,
      slug: sportLabel,
      label: sportLabel,
    }));

    console.log(`[sports-universe] /sports endpoint returned ${result.length} tag IDs across ${sports.length} sports`);
    return result;
  } catch (err) {
    console.warn('[sports-universe] /sports endpoint error:', err.message, '— falling back to tag keyword search');
    return null;
  }
}
```

Then update `fetchPolymarketSportsTags()` to try `/sports` first, fall back to existing keyword approach:

```javascript
async function fetchPolymarketSportsTags() {
  // Try /sports endpoint first (authoritative, fast)
  const fromSportsEndpoint = await fetchPolymarketSportsTagsFromSportsEndpoint();
  if (fromSportsEndpoint && fromSportsEndpoint.length > 0) {
    return fromSportsEndpoint;
  }
  // Fallback: keyword search across all tags (slower, comprehensive)
  // ... existing code unchanged below this point
}
```

**Files affected:** `lib/ingestion/sports-universe.mjs`
**Expected output:** Tag discovery uses `/sports` → returns real tag IDs → market fetch returns actual Polymarket sports markets.

---

### Step 3: Fix JSON parsing of outcomePrices

File: `lib/ingestion/sports-universe.mjs`

In `ingestPolymarketSports`, locate the price extraction block:

```javascript
const outcomes = m?.outcomes || [];
const outcomePrices = m?.outcomePrices || [];
```

Replace with:

```javascript
const outcomes = m?.outcomes || [];
// outcomePrices is a STRINGIFIED JSON array in the Gamma API — must parse
let outcomePrices = [];
try {
  outcomePrices = typeof m?.outcomePrices === 'string'
    ? JSON.parse(m.outcomePrices)
    : (Array.isArray(m?.outcomePrices) ? m.outcomePrices : []);
} catch { outcomePrices = []; }
```

Also fix `clobTokenIds` similarly if used:

```javascript
let clobTokenIds = [];
try {
  clobTokenIds = typeof m?.clobTokenIds === 'string'
    ? JSON.parse(m.clobTokenIds)
    : (Array.isArray(m?.clobTokenIds) ? m.clobTokenIds : []);
} catch { clobTokenIds = []; }
```

**Files affected:** `lib/ingestion/sports-universe.mjs`
**Expected output:** Prices extracted correctly for all binary Polymarket sports markets.

---

### Step 4: Add `archived=false` to market status filter

File: `lib/ingestion/sports-universe.mjs`

The current status assignment is:

```javascript
status: m?.active ? "open" : "closed",
```

Replace with a more defensive mapping:

```javascript
// Polymarket: active=true + closed=false + archived=false = live market
const isLive = m?.active === true && m?.closed === false && m?.archived !== true;
status: isLive ? "active" : "closed",
```

This ensures that the `status` field written to `pmci.provider_markets` is `'active'` (not `'open'`), consistent with how Kalshi markets are stored. This also fixes the anomaly where `active=0` was observed for all Polymarket records.

**Files affected:** `lib/ingestion/sports-universe.mjs`

---

### Step 5: Run ingestion and verify DB state

```bash
# Run a single ingest cycle manually
npm run pmci:ingest:sports

# Verify Polymarket sports markets now exist
node -e "
import('./src/platform/env.mjs').then(({loadEnv}) => {
  loadEnv();
  const { Client } = require('pg');
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  c.connect().then(async () => {
    const r = await c.query(\`
      SELECT sport, COUNT(*)::int as cnt 
      FROM pmci.provider_markets 
      WHERE provider_id=2 AND category='sports' 
      GROUP BY 1 ORDER BY 2 DESC
    \`);
    console.log('Polymarket sports:', JSON.stringify(r.rows));
    await c.end();
  });
});
"
```

**Expected output:** At least 3 distinct sports with > 0 markets for `provider_id=2`. NBA, MLB, and at least one other should be present.

---

### Step 6: Run smoke test and schema verify

```bash
npm run pmci:smoke
npm run verify:schema
```

---

## Verification

Phase E1.4 is complete when:

- [ ] `provider_id=2, category='sports'` count > 0 (target: at minimum 50+ markets across 3+ sports)
- [ ] Polymarket sports markets have `status='active'` in the DB (not `'open'` or `NULL`)
- [ ] `outcomePrices` are being parsed as numbers (not stringified arrays in metadata)
- [ ] `npm run pmci:smoke` passes
- [ ] `npm run verify:schema` passes

---

## Rollback

The changes are additive — reverting `active=true` and the `/sports` endpoint fallback restores prior behavior (which produced 0 markets, so there's nothing to roll back in terms of data). If the `/sports` endpoint causes errors, the fallback to keyword-based tag search handles it automatically.

---

## What comes next (E1.5)

Once Polymarket sports markets are in the DB:
1. Run `npm run pmci:ingest:sports` for ~3-7 days to accumulate stable market data
2. Adapt `proposal-engine.mjs` to accept `category='sports'` parameter (currently hardcoded to `'politics'`)
3. Run sports proposer dry-run to see how many cross-platform pairs emerge
4. Validate first batch manually before enabling auto-accept for sports
