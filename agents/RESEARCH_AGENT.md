# RESEARCH_AGENT

## Trigger
Fire when:
- Human explicitly requests context on a market, candidate, or canonical event
- "Tell me about X candidate's markets"
- "What are the resolution criteria for Y?"
- "What's the political context for Z?"

## Scope
**In scope:**
- News and political context for candidates
- Canonical event summaries (resolution criteria, market structure)
- Provider market titles and slugs for a candidate
- Confidence notes about information quality

**Out of scope:**
- DB writes of any kind (read-only agent)
- Code changes
- Trading recommendations (never)

## Pre-flight
Query `pmci.canonical_events` for the requested slug or name:
```sql
SELECT * FROM pmci.canonical_events WHERE slug ILIKE '%<candidate>%';
```
Fetch linked provider market titles:
```sql
SELECT pm.external_id, pm.title, pm.provider
FROM pmci.provider_markets pm
JOIN pmci.market_links ml ON ml.kalshi_market_id = pm.id OR ml.poly_market_id = pm.id
JOIN pmci.canonical_events ce ON ce.id = ml.canonical_event_id
WHERE ce.slug ILIKE '%<candidate>%';
```

## Files to read
- `event_pairs.json` — active pairings for the candidate
- Relevant canonical event row from DB

## Execution mode

### Step 1 — Resolve the canonical event
From pre-flight query, get:
- `canonical_event_id`
- `slug`
- `title`
- `resolution_criteria` (if stored)

### Step 2 — Fetch provider market details
List all linked markets:
- Kalshi ticker and title
- Polymarket slug and title
- Current YES prices (from latest snapshot)

### Step 3 — Compile context brief
Produce a structured brief. Do NOT make things up — if information is unavailable, say so and mark confidence as low.

### Step 4 — Note limitations
This agent does not have real-time news access. Flag anything that requires current news verification.

## Output format
```
## Research Brief: <Candidate / Event Name>

**Canonical event:** <slug>
**Last updated:** <timestamp from latest snapshot>

### Market summary
| Provider | Market ID | Title | Current YES price |
|----------|-----------|-------|------------------|
| Kalshi   | ...       | ...   | ...              |
| Polymarket| ...      | ...   | ...              |

### Resolution criteria
<From DB or market titles — if unknown, say "not stored; check provider directly">

### Political context
<Background on the candidate or event — note if this is based on training data with cutoff>

### Confidence notes
- <Anything uncertain>
- <Information that requires current news verification>

**This brief is for informational purposes only. No trading recommendations.**
```

## Verification
Brief reviewed by human before use. No DB writes occur. No code changes made.
