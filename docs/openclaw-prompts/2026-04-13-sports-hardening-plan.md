# OpenClaw Execution Prompt: Sports Proposer Hardening
> Generated: 2026-04-13
> Branch: main

## PMCI Invariants
[PMCI invariants: no .env writes; run verify:schema after migrations;
new routes in src/api.mjs only; inactive-guard before bulk market changes;
never skip npm run verify:schema]

## Situation Summary
Phase E1.5 is marked complete but the sports proposer has 3 confirmed bugs leaving 66 pending proposals in an unacceptable state. All 66 proposals have `date_delta_days = NULL`, meaning the date-gap guard is not firing. Two other structural issues (1-to-many fan-out and event-type mismatch re-proposals) are also unresolved. Nothing in the queue should be accepted until all 3 bugs are fixed and the proposer is re-run clean.

Read these files before touching any code:
- `/Users/jaylenjohnson/prediction-machine/scripts/review/pmci-propose-links-sports.mjs`
- `/Users/jaylenjohnson/prediction-machine/lib/matching/proposal-engine.mjs`
- `/Users/jaylenjohnson/prediction-machine/docs/db-schema-reference.md`

## Track A — Fix the 3 proposer bugs (sequential, hard gates)

### A1 — date_delta_days is NULL on all 66 pending proposals
**What to do:**
In `scripts/review/pmci-propose-links-sports.mjs`, find where proposals are inserted into `pmci.proposed_links`.
Find where `game_date` is read from `provider_markets` for each candidate pair (columns: `game_date` on both sides).
The `reasons` JSONB column should contain `date_delta_days` = ABS(game_date_a - game_date_b) in integer days.
Fix: compute `date_delta_days` correctly and write it into `reasons`.
Add gate: if `date_delta_days > 7`, do NOT insert the proposal — log it as skipped with reason `"date_gap:{N}d"`.

**Hard gate A1:**
Re-run `npm run pmci:propose:sports`
Then run this query and confirm date_delta_days is NOT null and no pending proposals have delta > 7:
```sql
SELECT reasons->>'date_delta_days' as delta, COUNT(*)
FROM pmci.proposed_links
WHERE category='sports' AND decision IS NULL
GROUP BY 1 ORDER BY 1;
```
Stop and show me the diff + query result before committing.

---

### A2 — 1-to-many fan-out (Elche/Valencia and Girona/Real Madrid — 24 proposals each)
**What to do:**
In the proposer, after A1 is committed, add a fan-out suppression rule:
If a single Kalshi market produces more than 3 proposals for the same `matchup_key` in one run,
emit only the highest-confidence pair and log the rest as skipped with reason `"fan_out_suppressed"`.

**Hard gate A2:**
After re-running `npm run pmci:propose:sports`, run:
```sql
SELECT reasons->>'matchup_key', COUNT(*) as proposals
FROM pmci.proposed_links
WHERE category='sports' AND decision IS NULL
GROUP BY 1
ORDER BY 2 DESC LIMIT 10;
```
No matchup_key should have more than 3 pending proposals.
Stop and show me the diff + query result before committing.

---

### A3 — Arsenal/Sporting CP event-type mismatch re-proposals
**What to do:**
Add an event-type compatibility check to the proposer.
Map Kalshi market types and Polymarket sub-types into buckets:
- `moneyline_winner`: win, winner, match winner, first half winner, halftime winner
- `totals`: totals, over/under, O/U 1.5, O/U 2.5, O/U 3.5, O/U 4.5
- `btts`: both teams to score, BTTS
- `spread`: handicap, spread, -1.5, +1.5

Only propose pairs where both markets map to the same bucket.
Log cross-bucket pairings as skipped with reason `"market_type_mismatch:{typeA}:{typeB}"`.

**Hard gate A3:**
After re-running `npm run pmci:propose:sports`, run:
```sql
SELECT reasons->>'skip_reason', COUNT(*)
FROM pmci.proposed_links
WHERE category='sports' AND decision = 'rejected'
  AND reasons->>'skip_reason' ILIKE '%market_type_mismatch%'
GROUP BY 1;
```
Arsenal/Sporting CP "First Half Winner vs O/U" should now be filtered with `market_type_mismatch` reason.
Stop and show me the diff + query result before committing.

---

## Track B — Final clean run + verification

After all 3 bugs are committed:

1. Delete existing pending proposals for sports to get a clean slate:
```sql
DELETE FROM pmci.proposed_links WHERE category='sports' AND decision IS NULL;
```
**Confirm count = 0 before proceeding.**

2. Re-run the proposer:
```bash
npm run pmci:propose:sports
```

3. Run full verification:
```bash
npm run pmci:smoke
npm run pmci:probe
npm run verify:schema
```

4. Return the full output of the following query:
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

Stop here. Do not accept any proposals. Return the full query result and I will review before any accepts.

---

## Track C — Git hygiene (after Track B passes)

Commit all changes with:
```
fix(E1): harden sports proposer — date gate, fan-out suppression, market-type bucket filter

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

Update `/Users/jaylenjohnson/prediction-machine/docs/system-state.md`:
Add an entry under "Current Status" for 2026-04-13 noting:
- Sports proposer hardened: date_delta_days gate active (>7d rejected), fan-out cap (max 3/matchup), market-type bucket filter
- 66 stale pending proposals cleared, clean re-run completed
- Pending queue count after clean run: [insert actual count from Track B query]

## Reference files (Plumbo reads — do not paste contents)
- `/Users/jaylenjohnson/prediction-machine/scripts/review/pmci-propose-links-sports.mjs`
- `/Users/jaylenjohnson/prediction-machine/lib/matching/proposal-engine.mjs`
- `/Users/jaylenjohnson/prediction-machine/docs/db-schema-reference.md`
- `/Users/jaylenjohnson/prediction-machine/docs/system-state.md`
