# Phase E1.3 — Proposer Hardening Schema & Architecture

## Data Models

No schema migrations required for this phase. All changes are logic-level within the proposal engine.

### Relevant columns (already exist)

```sql
-- pmci.provider_markets
close_time     TIMESTAMPTZ   -- used by expired-market guard (Step 2)
                             -- filter: close_time IS NULL OR close_time > NOW()

-- pmci.proposed_links
decision       TEXT          -- NULL=pending, 'accepted', 'rejected', 'skipped'
reviewer_note  TEXT          -- populated by auto-reject with machine reason
reviewed_at    TIMESTAMPTZ   -- set to NOW() on any decision write
features       JSONB         -- stores reasons/scoring signals (read-only in this phase)

-- pmci.market_links
status         TEXT          -- 'active' | 'removed' — dedup guard reads this
provider_market_id INT       -- used to detect already-linked Kalshi markets
```

### New script output contract

`scripts/review/pmci-clear-stale-proposals.mjs` writes to stdout:

```json
{
  "rejected_expired": [
    { "id": 181, "reason": "kalshi close_time 2026-01-01 < now", "titles": ["Japan snap election...", "Trump visit Japan..."] },
    { "id": 198, "reason": "kalshi close_time 2025-01-20 < now", "titles": ["RFK Jr...", "RFK announce..."] },
    { "id": 205, "reason": "kalshi close_time 2025-01-20 < now", "titles": ["Biden pardons...", "Trump out before..."] }
  ],
  "rejected_manual": [
    { "id": 184, "reason": "nomination != election win; different event types" },
    { "id": 199, "reason": "nomination != campaign announcement; different event types" }
  ],
  "total_rejected": 5
}
```

---

## Architectural Decisions

### Why filter expired markets in SQL, not application code

The market-load query in proposal-engine.mjs fetches all candidate markets from both providers before scoring pairs. Adding `close_time > NOW()` to the SQL WHERE clause keeps expired markets entirely out of the candidate pool — they never consume scoring CPU and can never accidentally slip through with a high confidence score. Application-level filtering after scoring would still waste scoring cycles.

### Why title_similarity floor = 0.30

Analysis of the 5 pending items shows genuine cross-platform matches (the 138 accepted links) have `title_similarity` in the 0.4–0.8 range. The garbage matches that reached the queue had 0.08–0.27. A floor of 0.30 separates the noise from real pairs with minimal false-negative risk for genuinely equivalent markets (different phrasing of the same event typically scores ≥0.35 via Jaccard on normalized tokens).

### Why dedup via market_links, not proposed_links

Checking `pmci.proposed_links` for prior proposals would prevent re-proposing after a manual reject (correct) but also wouldn't catch cases where a market was linked via a different mechanism (e.g., manually inserted link). Checking `pmci.market_links` for active links is more authoritative and matches the intent: "does this market already have a live cross-platform pairing?"

### Stale-clear is a one-shot script, not a migration

These 5 items are a one-time cleanup. Future proposals won't have this problem once the expired-market guard (Step 2) is in place. A standalone script with a `RETURNING` clause that prints what it changed is safer than an embedded migration — it's inspectable, re-runnable, and leaves an audit trail in stdout logs.

---

## Dependencies

No new dependencies. Changes use existing:
- `pg` (postgres client)
- Existing DB schema — no migrations
- Existing `proposal-engine.mjs` scoring pipeline

---

## Environment Variables

No new env vars. Guards use existing `DATABASE_URL`.
