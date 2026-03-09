# MARKET_DISCOVERY

## Trigger
Fire when:
- `provider_markets` count drops unexpectedly
- New political cycle starts (primary, general, special election)
- Manual discovery request ("find new markets for X")
- Coverage check shows gaps in `event_pairs.json`

## Scope
**In scope:**
- Discovering new markets on Kalshi and Polymarket
- Expanding `event_pairs.json` with new candidate/event pairings
- Triggering ingestion after discovery
- Checking for dual-listed markets (same candidate on both platforms)

**Out of scope:**
- Link proposals between discovered markets (→ `agents/LINKER_PROPOSER.md`)
- Data quality of existing snapshots (→ `agents/general/DB_AUDITOR.md`)

## Pre-flight
```bash
npm run pmci:probe    # Row counts: provider_markets, families, links
npm run pmci:smoke    # Assert > 0 on key tables
```
Note current `provider_markets` count before discovery run.

## Files to read
- `event_pairs.json` — current active pairings (Kalshi slug ↔ Polymarket slug)
- `scripts/pmci-ingest-politics-universe.mjs` — broad ingestion logic
- `scripts/discover-dem-2028-dual-listings.mjs` — dual-listing discovery

## Execution mode

### Step 1 — Assess current coverage
From `pmci:probe` output, note:
- `provider_markets` count per provider
- Which canonical_events have < 2 linked provider markets

### Step 2 — Discover new markets
Run the relevant discovery script:
```bash
node scripts/pmci-ingest-politics-universe.mjs   # broad politics ingest
# or
node scripts/discover-dem-2028-dual-listings.mjs  # Dem 2028 dual listings
```

Look for candidates/events present on one platform but not `event_pairs.json`.

### Step 3 — Propose additions to event_pairs.json
For each new pairing found:
```json
{
  "kalshi_slug": "<series_ticker>",
  "polymarket_slug": "<slug>#<CandidateName>",
  "label": "<Human-readable label>"
}
```

Filter out placeholder slots (Player X, Person X, Option X).

### Step 4 — Trigger ingestion
After updating `event_pairs.json`:
```bash
npm run start   # Run 1–2 observer cycles
npm run pmci:probe  # Confirm provider_markets count increased
```

## Output format
```
## Market Discovery Report

**Before:** provider_markets = <N>
**Discovery run:** <script used>

### New pairings found
| Kalshi slug | Polymarket slug | Label |
|-------------|-----------------|-------|
| ...         | ...             | ...   |

### event_pairs.json diff
<JSON diff>

### Post-ingestion
```bash
npm run start
npm run pmci:probe
```
Expected: provider_markets > <N>
```

## Verification
```bash
npm run pmci:probe
# provider_markets count must be greater than before discovery run
```
