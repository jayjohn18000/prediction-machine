# PROPOSAL_REVIEWER

## Purpose
Systematically clear the `pmci.proposed_links` review queue by:
1. Detecting and bulk-rejecting bad-match patterns
2. Auto-accepting high-confidence valid pairs
3. Surfacing the remaining ambiguous proposals for human review

Used by the `/pmci-review` Claude Code skill as a pre-pass before interactive review.

---

## Trigger
Fire when:
- `proposed_links` has pending proposals (`decision IS NULL`)
- `/pmci-review` finds "No pending proposals" but DB shows pending count > 0
- Queue is large (> 10 pending) and needs triage before manual review
- Human requests "bulk review", "clear the queue", or "triage proposals"

---

## Pre-flight

```bash
# 1. Count pending
node --input-type=module -e "
import { query } from './src/db.mjs';
const r = await query(\"SELECT count(*) as n FROM pmci.proposed_links WHERE decision IS NULL\");
console.log('Pending:', r.rows[0].n);
"

# 2. Confidence distribution
node --input-type=module -e "
import { query } from './src/db.mjs';
const r = await query(\`
  SELECT round(confidence,2) as conf, count(*) as n
  FROM pmci.proposed_links WHERE decision IS NULL
  GROUP BY round(confidence,2) ORDER BY conf DESC
\`);
r.rows.forEach(row => console.log(row.conf, '->', row.n));
"
```

---

## Step 1 — Bulk-reject bad patterns

Run each pattern check and apply the SQL. Record counts for the report.

### Pattern A: Cross-geography mismatch
Same-topic (party wins Senate) Kalshi market fanned out against many different-state Polymarket markets.

**Detection query:**
```sql
SELECT ma.provider_market_ref, count(*) as n
FROM pmci.proposed_links pl
JOIN pmci.provider_markets ma ON ma.id = pl.provider_market_id_a
JOIN pmci.provider_markets mb ON mb.id = pl.provider_market_id_b
WHERE pl.decision IS NULL
  AND (
    -- State name in A title doesn't appear in B title
    -- Heuristic: A slug has a state code, B slug has a different state
    ma.provider_market_ref != mb.provider_market_ref
  )
GROUP BY ma.provider_market_ref
HAVING count(*) > 3  -- same Kalshi market paired 3+ times = fan-out signal
ORDER BY n DESC;
```

**Bulk reject:**
```sql
UPDATE pmci.proposed_links pl
SET decision = 'rejected',
    reviewed_at = now(),
    reviewer_note = 'bulk-reject: cross-geography fan-out (same Kalshi market paired against many unrelated Polymarket state markets)'
FROM pmci.provider_markets ma
WHERE pl.provider_market_id_a = ma.id
  AND pl.decision IS NULL
  AND ma.provider_market_ref IN (
    -- paste the refs from the detection query above
  );
```

### Pattern B: Placeholder candidate names
Polymarket markets with generic slot names (Candidate I, Player X, Person X, Option X) should never be linked.

**Bulk reject:**
```sql
UPDATE pmci.proposed_links pl
SET decision = 'rejected',
    reviewed_at = now(),
    reviewer_note = 'bulk-reject: placeholder candidate slot (Candidate I / Player X / Person X / Option X)'
FROM pmci.provider_markets ma, pmci.provider_markets mb
WHERE pl.provider_market_id_a = ma.id
  AND pl.provider_market_id_b = mb.id
  AND pl.decision IS NULL
  AND (
    ma.title ~* '\m(Candidate [A-Z]|Player \d+|Person \d+|Option \d+)\M'
    OR mb.title ~* '\m(Candidate [A-Z]|Player \d+|Person \d+|Option \d+)\M'
  );
```

### Pattern C: Inverted outcome pairing
`#No` or `#Republican` Polymarket ref paired with a question asking about Democrats (or vice versa).

**Bulk reject:**
```sql
UPDATE pmci.proposed_links pl
SET decision = 'rejected',
    reviewed_at = now(),
    reviewer_note = 'bulk-reject: inverted outcome (affirmative question paired with #No or opposing-party ref)'
FROM pmci.provider_markets ma, pmci.provider_markets mb
WHERE pl.provider_market_id_a = ma.id
  AND pl.provider_market_id_b = mb.id
  AND pl.decision IS NULL
  AND (
    (mb.provider_market_ref ILIKE '%#No' AND ma.title ILIKE '%Will%Democrat%')
    OR (mb.provider_market_ref ILIKE '%#Republican%' AND ma.title ILIKE '%Democrat%')
    OR (mb.provider_market_ref ILIKE '%#Democrat%' AND ma.title ILIKE '%Republican%')
  );
```

### Pattern D: Cross-country mismatch
US markets paired against Canadian, UK, or other foreign markets.

**Bulk reject:**
```sql
UPDATE pmci.proposed_links pl
SET decision = 'rejected',
    reviewed_at = now(),
    reviewer_note = 'bulk-reject: cross-country mismatch (US market paired with non-US market)'
FROM pmci.provider_markets ma, pmci.provider_markets mb
WHERE pl.provider_market_id_a = ma.id
  AND pl.provider_market_id_b = mb.id
  AND pl.decision IS NULL
  AND (
    (ma.title ILIKE '%United States%' OR ma.title ILIKE '%Senate%' OR ma.title ILIKE '%Congress%')
    AND (mb.provider_market_ref ILIKE '%toronto%' OR mb.provider_market_ref ILIKE '%canada%'
         OR mb.provider_market_ref ILIKE '%uk-%' OR mb.provider_market_ref ILIKE '%london%')
  );
```

### Pattern E: Inverted outcome name (outcome_name_match = 0)
The proposer computes `features.outcome_name_match` but doesn't use it in confidence scoring.
Value = 0 means outcomes are completely inverted (e.g. #No vs #Yes, Dem vs Rep).

**Detection query:**
```sql
SELECT pl.id, ma.title, mb.title, pl.confidence
FROM pmci.proposed_links pl
JOIN pmci.provider_markets ma ON ma.id = pl.provider_market_id_a
JOIN pmci.provider_markets mb ON mb.id = pl.provider_market_id_b
WHERE pl.decision IS NULL
  AND pl.features IS NOT NULL
  AND (pl.features->>'outcome_name_match')::numeric = 0;
```

**Bulk reject:**
```sql
UPDATE pmci.proposed_links pl
SET decision = 'rejected', reviewed_at = now(),
    reviewer_note = 'bulk-reject: outcome_name_match=0 — outcomes completely inverted (Pattern E)'
WHERE pl.decision IS NULL
  AND pl.features IS NOT NULL
  AND (pl.features->>'outcome_name_match')::numeric = 0;
```

Note: `outcome_name_match IS NULL` (no named outcome) is NOT rejected. Only `= 0` triggers.

### Pattern F: Extreme close-time delta (> 120 days)
Markets resolving > 120 days apart almost certainly cover different events.
`features.date_delta_days` holds the delta.

**Detection query:**
```sql
SELECT pl.id, ma.title, mb.title,
       (pl.features->>'date_delta_days')::int AS delta_days
FROM pmci.proposed_links pl
JOIN pmci.provider_markets ma ON ma.id = pl.provider_market_id_a
JOIN pmci.provider_markets mb ON mb.id = pl.provider_market_id_b
WHERE pl.decision IS NULL
  AND pl.features IS NOT NULL
  AND (pl.features->>'date_delta_days')::int > 120;
```

**Exception:** Before applying, scan for primary→general pairs (same candidate name, one title has "primary", other has "general") — these may be legitimate proxy links. Exclude their IDs from the bulk SQL.

**Bulk reject:**
```sql
UPDATE pmci.proposed_links pl
SET decision = 'rejected', reviewed_at = now(),
    reviewer_note = 'bulk-reject: extreme date delta >120 days (Pattern F)'
WHERE pl.decision IS NULL
  AND pl.features IS NOT NULL
  AND (pl.features->>'date_delta_days')::int > 120
  AND pl.id NOT IN (/* primary→general IDs identified in manual scan */);
```

Threshold: 120 days chosen because US primary→general cycles are 150–210 days apart (correctly excluded) while same-event markets typically differ by ≤ 30 days.

---

## Step 2 — Auto-accept high-confidence valid pairs

After rejecting bad patterns, run the auto-accept pass on proposals that clear all three gates.

**Gates for auto-accept:**
| Gate | Condition |
|------|-----------|
| Confidence | ≥ 0.95 |
| Entity token match | `matched_tokens` contains a real name (not "wil", "the", "will") |
| Geography alignment | State/city in Market A title appears in Market B slug or title |
| No placeholder | Neither title contains generic slot names |
| Year alignment | If a year appears in both titles, they must match |

**Query to identify auto-accept candidates:**
```sql
SELECT pl.id, ma.title as title_a, mb.title as title_b, pl.confidence, pl.reasons
FROM pmci.proposed_links pl
JOIN pmci.provider_markets ma ON ma.id = pl.provider_market_id_a
JOIN pmci.provider_markets mb ON mb.id = pl.provider_market_id_b
WHERE pl.decision IS NULL
  AND pl.confidence >= 0.95
  AND NOT (
    ma.title ~* '\m(Candidate [A-Z]|Player \d+|Person \d+|Option \d+)\M'
    OR mb.title ~* '\m(Candidate [A-Z]|Player \d+|Person \d+|Option \d+)\M'
  )
ORDER BY pl.confidence DESC;
```

**Review each row manually before bulk-accepting.** If the titles clearly match (same candidate, same race, same geography), apply:

```sql
UPDATE pmci.proposed_links
SET decision = 'accepted',
    reviewed_at = now(),
    reviewer_note = 'auto-accept: high confidence, entity match, geography aligned'
WHERE id IN (<ids from above>)
  AND decision IS NULL;
```

---

## Step 3 — Surface remaining proposals for human review

After Steps 1–2, query what's left:

```sql
SELECT pl.id, round(pl.confidence,3) as conf,
       ma.provider_market_ref as ref_a, ma.title as title_a,
       mb.provider_market_ref as ref_b, mb.title as title_b,
       pl.reasons->>'matched_tokens' as matched_tokens
FROM pmci.proposed_links pl
JOIN pmci.provider_markets ma ON ma.id = pl.provider_market_id_a
JOIN pmci.provider_markets mb ON mb.id = pl.provider_market_id_b
WHERE pl.decision IS NULL
ORDER BY pl.confidence DESC;
```

Format each as a card and present via `AskUserQuestion` (accept / reject / skip).
These are the truly ambiguous cases — different entity name formats, multi-candidate slugs, cross-cycle events.

---

## Step 4 — Produce review report

```
## Proposal Review Report — [date]

Pending at start:     [N]
─────────────────────────────
Bulk rejected:        [N]
  Pattern A (cross-geography fan-out):  [N]
  Pattern B (placeholder candidates):   [N]
  Pattern C (inverted outcome):         [N]
  Pattern D (cross-country):            [N]
  Pattern E (outcome_name_match=0):     [N]
  Pattern F (extreme date delta >120d): [N]

Auto-accepted:        [N]
Human reviewed:       [N] accepted / [N] rejected / [N] skipped

Remaining pending:    [N]
─────────────────────────────
Active links after:   [N]  (run npm run pmci:probe to confirm)
```

---

## Verification

```bash
npm run pmci:probe   # confirm active_links count increased
npm run pmci:smoke   # assert > 0 snapshots and families
```

---

## Guardrails

- Never auto-accept a proposal where a placeholder name is present in either market title
- Never auto-accept cross-geography pairs (different US state, different country)
- Never auto-accept if the year in Market A and Market B differ
- Do not modify `confidence` scores — only record `decision`, `reviewed_at`, `reviewer_note`
- If bulk-reject count exceeds 80% of pending, flag to human before applying — may indicate a proposer bug

---

## Files to read
- `scripts/pmci-review-cli.mjs` — interactive review CLI (used for human-review phase)
- `scripts/pmci-check-proposals.mjs` — proposal count and status query
- `src/routes/review.mjs` — API review queue logic and confidence threshold (`min_confidence` default)
- `agents/LINKER_PROPOSER.md` — if pattern rejections are systemic, the proposer needs a fix

---

## Enhancement signals
Used by `agents/AGENT_ENHANCER.md` to mine this agent's data trail.

Data source: `pmci.proposed_links` (joined to `pmci.provider_markets`)
Key fields:  `decision`, `reviewer_note`, `reasons` (JSONB), `features` (JSONB), `confidence`

Query goals:
1. Unhandled outcome inversion: `features->>'outcome_name_match' = '0'`, `decision='rejected'`
   → new Pattern candidate if ≥ 3 rows
2. Extreme date delta: `(features->>'date_delta_days')::int > 120`, `decision='rejected'`
   → Pattern F threshold calibration if evidence diverges from 120
3. Recurring manual notes: `reviewer_note NOT LIKE 'bulk-reject:%'`, count ≥ 2
   → new named pattern candidate
4. Fan-out calibration: same `provider_market_id_a`, count > 2, all rejected
   → propose lowering Pattern A threshold if threshold=3 and all count=3 rejected
5. Price source asymmetry: `price_source_a IS NULL AND price_source_b IS NOT NULL`
   → guardrail addition candidate if ≥ 2 rows rejected for this reason

Rejection threshold: 3 evidence rows minimum before proposing a new pattern.
Fan-out threshold floor: never propose below 2 (would risk rejecting valid pairs).
