# Phase E1.3 — Proposer Hardening (Automation Wins)

**Status:** Ready to execute
**Entry criteria:** Phase E1.2 (sports ingestion) complete ✓ (2026-04-01)
**Goal:** Eliminate garbage proposals from the review queue by hardening the proposal engine with three guards and one auto-reject script for the 5 known stale pending items.

---

## Overview

The review queue analysis (2026-04-01) found 5 pending proposals — all stale (24+ days old), all rejects. Root cause: the proposer allows expired markets, has no title-similarity floor for equivalent proposals, and generates duplicate proposals for already-linked markets. This phase ships three targeted guards inside the proposal engine + a one-shot stale-clear script.

## Prerequisites

- Phase E1.2 complete (schema columns `sport`, `game_date`, `close_time` exist) ✓
- `lib/matching/proposal-engine.mjs` is the canonical proposal generation file
- `scripts/review/pmci-propose-links-politics.mjs` is the entry point that calls the engine
- `npm run pmci:check:proposals` is the CI gate (must pass after changes)

---

## Execution Steps

### Step 1: One-shot stale queue clear script

Create `scripts/review/pmci-clear-stale-proposals.mjs`.

This script connects to the DB and sets `decision='rejected'` + `reviewer_note` on all 5 known pending items (IDs 181, 184, 198, 199, 205), plus any future pending items where the Kalshi or Polymarket market's `close_time < NOW()`.

```javascript
// Logic:
// UPDATE pmci.proposed_links pl
// SET decision = 'rejected',
//     reviewed_at = NOW(),
//     reviewer_note = 'auto-rejected: expired market close_time < now'
// FROM pmci.provider_markets ma, pmci.provider_markets mb
// WHERE pl.provider_market_id_a = ma.id
//   AND pl.provider_market_id_b = mb.id
//   AND pl.decision IS NULL
//   AND (ma.close_time < NOW() OR mb.close_time < NOW())
// RETURNING pl.id, ma.title, mb.title, pl.confidence;
//
// For any remaining pending items after the above, reject individually with specific notes:
// IDs 184, 199: reviewer_note = 'rejected: nomination != election/announcement; different event types'
// Any remaining: reviewer_note = 'rejected: stale, no valid cross-platform pair'
```

**Files affected:** `scripts/review/pmci-clear-stale-proposals.mjs` (new file)
**Expected output:** Prints list of rejected IDs + titles. Running `npm run pmci:check:proposals` after should report queue is empty.

---

### Step 2: Expired-market guard in proposal engine

File: `lib/matching/proposal-engine.mjs`

In the market-loading SQL query (the `SELECT` that loads Kalshi + Polymarket markets before pair generation), add a `close_time` filter to exclude already-expired markets:

```sql
-- Add to the WHERE clause of both provider market queries:
AND (pm.close_time IS NULL OR pm.close_time > NOW())
```

This ensures no expired market ever enters the proposal candidate pool.

**Files affected:** `lib/matching/proposal-engine.mjs`
**Expected output:** Re-running the proposer after this change should not re-generate proposals for IDs 181, 198, 205.

---

### Step 3: Title-similarity floor for equivalent proposals

File: `lib/matching/proposal-engine.mjs`

Locate where `proposed_relationship_type = 'equivalent'` is assigned (before inserting into `pmci.proposed_links`). Add a validation gate:

```javascript
// Before marking a pair as 'equivalent', require:
const titleSimilarityFloor = 0.30;
const slugSimilarityFloor = 0.20;

if (
  proposedType === 'equivalent' &&
  reasons.title_similarity < titleSimilarityFloor &&
  (reasons.slug_similarity ?? 0) < slugSimilarityFloor
) {
  // Downgrade to proxy if confidence is still above proxy threshold, else skip
  if (confidence >= 0.88) {
    proposedType = 'proxy';
    reasons.downgraded_from = 'equivalent';
    reasons.downgrade_reason = 'title_similarity_below_floor';
  } else {
    continue; // skip — not a useful pair
  }
}
```

**Files affected:** `lib/matching/proposal-engine.mjs`
**Expected output:** IDs 184 and 199 (confidence 0.969/0.930, title_similarity 0.27/0.20) would be downgraded from equivalent→proxy or skipped. Reduces false-equivalent noise.

---

### Step 4: Duplicate-target dedup check

File: `lib/matching/proposal-engine.mjs`

Before inserting a new proposal row, check whether `provider_market_id_a` already has an accepted proposal OR an active market link in `pmci.market_links`:

```javascript
// Before insert, run:
const existingLink = await client.query(`
  SELECT 1 FROM pmci.market_links ml
  JOIN pmci.market_families mf ON ml.family_id = mf.id
  WHERE ml.provider_market_id = $1 AND ml.status = 'active'
  LIMIT 1
`, [marketIdA]);

if (existingLink.rows.length > 0) {
  // skip — this Kalshi market already has an active cross-platform link
  stats.skipped_already_linked = (stats.skipped_already_linked || 0) + 1;
  continue;
}
```

**Files affected:** `lib/matching/proposal-engine.mjs`
**Expected output:** Eliminates the duplicate-Trump-nominee pattern (IDs 184, 199 both reference the same Kalshi market already in the 138 active links).

---

### Step 5: Add `package.json` script for stale clear

Add to `package.json` scripts:

```json
"pmci:clear:stale": "node scripts/review/pmci-clear-stale-proposals.mjs"
```

**Files affected:** `package.json`

---

### Step 6: Run verification sequence

After all changes:

```bash
npm run pmci:clear:stale        # Reject 5 known stale items, prints affected rows
npm run pmci:check:proposals    # Confirm queue is empty
npm run pmci:smoke              # DB connectivity + table counts
npm run verify:schema           # Schema integrity
```

Expected: `pmci:check:proposals` reports queue empty or 0 pending items.

---

## Verification

Phase E1.3 is complete when:
- [ ] `pmci:check:proposals` reports 0 pending items in the queue
- [ ] Re-running the proposer does NOT re-propose the rejected pairs
- [ ] No new equivalent proposals are generated with `title_similarity < 0.30 AND slug_similarity < 0.20`
- [ ] All 4 changed files pass `npm run verify:schema`

---

## Rollback

- The stale-clear script only sets `decision='rejected'` — decisions can be flipped back to `NULL` manually if needed:
  ```sql
  UPDATE pmci.proposed_links SET decision = NULL, reviewed_at = NULL, reviewer_note = NULL
  WHERE id IN (181, 184, 198, 199, 205);
  ```
- The proposal engine guards are additive filters — removing them restores prior behavior exactly.
