# OpenClaw Handoff: Sports Proposer Hardening (A1/A2/A3)
> Generated: 2026-04-13 — Claude Cowork handoff to Plumbo
> Branch: main

## PMCI Invariants
[PMCI invariants: no .env writes; run verify:schema after migrations;
new routes in src/api.mjs only; inactive-guard before bulk market changes;
never skip npm run verify:schema. Do not accept any proposals.]

## What Claude Already Did

All three bug fixes are coded and saved to disk. Read these two files — the changes are already there:
- `/Users/jaylenjohnson/prediction-machine/lib/matching/sports-helpers.mjs`
- `/Users/jaylenjohnson/prediction-machine/scripts/review/pmci-propose-links-sports.mjs`

**A1 (date_delta_days NULL):** Fixed `sportsEntityFromMarket` and `sportsDateDeltaDays` in sports-helpers.mjs to handle JS Date objects returned by pg (was `String(date).slice(0,10)` → "Mon Apr 13", not a valid ISO string → NaN → null delta). Added null/>`7d` gate in proposer.

**A2 (fan-out suppression):** Added `proposalsPerMatchup` Map. Candidates per Kalshi market are now sorted by confidence desc / dateDelta asc and capped at 3 per matchup_key globally.

**A3 (market-type mismatch):** Added `classifyMarketTypeBucket()` to sports-helpers.mjs (moneyline_winner / totals / btts / spread). Cross-bucket pairs are rejected. Currently inserts one DB row per rejection inline — **this is the problem you need to fix first (see Step 1 below).**

## Current DB State (verified)
- `pmci.proposed_links WHERE category='sports' AND decision='accepted'` → **10 rows** (the accepted pairs — do NOT touch these)
- `pmci.proposed_links WHERE category='sports' AND decision='rejected'` → ~4,900 partial rows from a killed run — **need to be cleared**
- `pmci.proposed_links WHERE category='sports' AND decision IS NULL` → **0 rows** (clean slate ready)

## Why Claude Handed Off
Desktop Commander times out at 60s running the proposer. The proposer's inline per-row A3 DB inserts (one INSERT per mismatch pair) caused 4,900+ roundtrips and the run took 5+ minutes still unfinished. Claude killed it. The fix is to batch the A3 inserts.

---

## Step 1 — Fix A3 to batch-insert rejections (edit the proposer)

In `/Users/jaylenjohnson/prediction-machine/scripts/review/pmci-propose-links-sports.mjs`:

**Current (bad — inline per-row):** Inside the inner `for (const p of poly)` loop, when `kBucket && pBucket && kBucket !== pBucket`, there is an `await client.query(INSERT ...)` for each rejection. This causes thousands of roundtrips.

**Fix:** Remove the inline INSERT. Instead:
1. Declare `const a3Rejections = [];` before the outer loop.
2. In the bucket-mismatch branch, push to the array instead of inserting:
   ```js
   a3Rejections.push([Math.min(k.id, p.id), Math.max(k.id, p.id), JSON.stringify(skipReasons)]);
   ```
3. After the outer loop completes, do a single batch INSERT for all A3 rejections (if any), like:
   ```js
   if (!dryRun && a3Rejections.length > 0) {
     const vals = a3Rejections.map((_, i) => `($${i*3+1}, $${i*3+2}, 'equivalent', 0.0, $${i*3+3}::jsonb, '{}'::jsonb, 'rejected')`).join(',');
     const flat = a3Rejections.flat();
     await client.query(
       `INSERT INTO pmci.proposed_links (category, provider_market_id_a, provider_market_id_b, proposed_relationship_type, confidence, reasons, features, decision)
        VALUES ${vals} ON CONFLICT DO NOTHING`,
       flat.map((v, i) => (i % 3 === 0 ? 'sports' : undefined) === undefined ? v : 'sports')
     );
   }
   ```
   Actually — simplest correct approach: use a VALUES list. Build it as:
   ```js
   if (!dryRun && a3Rejections.length > 0) {
     const rows = a3Rejections; // [{idA, idB, reasonsJson}]
     const values = [];
     const params = [];
     rows.forEach(([idA, idB, reasonsJson], i) => {
       const base = i * 3;
       values.push(`('sports', $${base+1}, $${base+2}, 'equivalent', 0.0, $${base+3}::jsonb, '{}'::jsonb, 'rejected')`);
       params.push(idA, idB, reasonsJson);
     });
     await client.query(
       `INSERT INTO pmci.proposed_links (category, provider_market_id_a, provider_market_id_b, proposed_relationship_type, confidence, reasons, features, decision) VALUES ${values.join(',')} ON CONFLICT DO NOTHING`,
       params
     );
   }
   ```
   Postgres has a ~65k param limit. If `a3Rejections.length * 3 > 60000`, split into chunks of 20000 rows each.

Also update the summary log line to include `a3_rejected=${a3Rejections.length}` for visibility.

---

## Step 2 — Clean the DB (clear partial A3 rows from killed run)

Run this SQL (use the Supabase CLI or a psql connection from ~/prediction-machine/.env DATABASE_URL):

```sql
DELETE FROM pmci.proposed_links
WHERE category = 'sports'
  AND decision = 'rejected'
  AND reasons->>'source' = 'sports_proposer_v1';
```

Confirm count = 0 rejected with source=sports_proposer_v1 before proceeding.

---

## Step 3 — Re-run the proposer

```bash
cd ~/prediction-machine && npm run pmci:propose:sports
```

This should complete in under 60 seconds now (no inline A3 inserts during the loop).

---

## Step 4 — Run all three gate queries and confirm

**A1 gate** — no NULL delta, no delta > 7:
```sql
SELECT reasons->>'date_delta_days' as delta, COUNT(*)
FROM pmci.proposed_links
WHERE category='sports' AND decision IS NULL
GROUP BY 1 ORDER BY 1;
```
Expected: all rows have a numeric delta value, none > 7.

**A2 gate** — no matchup_key with > 3 pending proposals:
```sql
SELECT reasons->>'matchup_key' as matchup, COUNT(*) as proposals
FROM pmci.proposed_links
WHERE category='sports' AND decision IS NULL
GROUP BY 1
ORDER BY 2 DESC LIMIT 10;
```
Expected: max count per matchup_key ≤ 3.

**A3 gate** — mismatch rejections are logged:
```sql
SELECT reasons->>'skip_reason', COUNT(*)
FROM pmci.proposed_links
WHERE category='sports' AND decision = 'rejected'
  AND reasons->>'skip_reason' ILIKE '%market_type_mismatch%'
GROUP BY 1;
```
Expected: rows present with market_type_mismatch:moneyline_winner:totals etc.

**Track B final query** — return the full pending queue for review:
```sql
SELECT
  reasons->>'matchup_key' as matchup,
  reasons->>'date_delta_days' as delta_days,
  confidence,
  COUNT(*) as count
FROM pmci.proposed_links
WHERE category='sports' AND decision IS NULL
GROUP BY 1, 2, 3
ORDER BY confidence DESC;
```

---

## Step 5 — Run full verification suite

```bash
cd ~/prediction-machine
npm run pmci:smoke
npm run pmci:probe
npm run verify:schema
```

All must pass. Return full output.

---

## Step 6 — Commit (Track C)

```bash
cd ~/prediction-machine
git add lib/matching/sports-helpers.mjs scripts/review/pmci-propose-links-sports.mjs
git commit -m "fix(E1): harden sports proposer — date gate, fan-out suppression, market-type bucket filter

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Step 7 — Update system-state.md

In `/Users/jaylenjohnson/prediction-machine/docs/system-state.md`, add an entry under "Current Status" for 2026-04-13:

```
2026-04-13: Sports proposer hardened (E1 follow-up)
  - A1: date_delta_days gate active — null deltas fixed (pg Date object handling), >7d pairs rejected
  - A2: fan-out cap active — max 3 proposals per matchup_key per run
  - A3: market-type bucket filter active — moneyline/totals/btts/spread cross-bucket pairs rejected to proposed_links with decision=rejected
  - 66 stale pending proposals cleared; clean re-run completed
  - Pending queue after clean run: [insert actual count from Track B query]
```

---

## Do Not
- Accept any proposals
- Write to .env
- Skip verify:schema
- Touch the 10 accepted rows (decision='accepted') in proposed_links
