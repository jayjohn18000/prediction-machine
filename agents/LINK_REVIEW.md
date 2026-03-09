# LINK_REVIEW

## Trigger
Fire when:
- `proposed_links` queue has pending proposals (`decision IS NULL`)
- `node scripts/pmci-check-proposals.mjs` shows pending count > 0
- Human requests review of the proposal queue

## Scope
**In scope:**
- Reviewing pending `proposed_links` records
- Applying confidence thresholds to accept/reject
- Escalating ambiguous edge cases to human
- Producing bulk decision plan

**Out of scope:**
- Generating new proposals (→ `agents/LINKER_PROPOSER.md`)
- Modifying link confidence algorithms (→ `agents/LINKER_PROPOSER.md`)

## Pre-flight
```bash
node scripts/pmci-check-proposals.mjs
```
Note pending count and any high-confidence proposals ready to auto-accept.

## Files to read
- `scripts/pmci-review-cli.mjs` — interactive review CLI and decision logic
- `scripts/pmci-check-proposals.mjs` — proposal count and status query

## Execution mode

### Step 1 — Query pending proposals
```bash
node scripts/pmci-check-proposals.mjs
```
Extract:
- Total pending count
- Breakdown by confidence score (if available)

### Step 2 — Apply confidence thresholds
| Confidence | Action |
|-----------|--------|
| ≥ 0.85 | Auto-accept (produce accept list) |
| 0.60–0.84 | Human review required |
| < 0.60 | Auto-reject (produce reject list) |

### Step 3 — Escalate edge cases
For proposals in the 0.60–0.84 range, summarize each for human review:
- Kalshi market title
- Polymarket market title
- Confidence score
- Why it's ambiguous

### Step 4 — Produce decision list
Output an accept/reject/skip list. For bulk decisions, use:
```bash
npm run pmci:review -- --accept <id>
npm run pmci:review -- --reject <id>
```
Or produce a SQL block for bulk update:
```sql
UPDATE pmci.proposed_links
SET decision = 'accepted', decided_at = now()
WHERE id IN (<ids>) AND confidence >= 0.85;
```

## Output format
```
## Link Review Report

**Pending proposals:** <N>

### Auto-accept (confidence ≥ 0.85)
| ID | Kalshi | Polymarket | Confidence |
|----|--------|------------|------------|
| ...| ...    | ...        | ...        |

### Human review needed (0.60–0.84)
| ID | Kalshi | Polymarket | Confidence | Why ambiguous |
|----|--------|------------|------------|---------------|
| ...| ...    | ...        | ...        | ...           |

### Auto-reject (< 0.60)
| ID | Confidence |
|----|------------|

### Bulk decision SQL
<SQL>
```

## Verification
```bash
node scripts/pmci-check-proposals.mjs
# Pending count must be 0 or less than before review
```
