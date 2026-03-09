# ANOMALY_DETECTOR

## Trigger
Fire when:
- Spread delta between Kalshi and Polymarket exceeds 0.08 (8 percentage points)
- Price divergence detected (same candidate, large gap between platforms)
- Coverage drop detected (provider_markets count drops or families lose links)
- Human requests "check for anomalies" or "why is X spread so wide"

## Scope
**In scope:**
- `pmci.provider_market_snapshots` spread analysis
- Identifying candidates with anomalous price divergence
- Coverage drops in market families
- Producing anomaly reports with SQL evidence

**Out of scope:**
- Trading or execution actions (never)
- Fixing divergences (observation only — divergence may be real)
- Provider API errors (→ `agents/general/API_DEBUGGER.md`)

## Pre-flight
```bash
node scripts/check-top-divergences.mjs   # if exists
node scripts/check-coverage.mjs          # if exists
```
Or run the SQL below directly via `node run-queries.mjs`.

## Files to read
- `scripts/check-top-divergences.mjs` — divergence query logic (if exists)
- `scripts/check-coverage.mjs` — coverage query logic (if exists)
- `run-queries.mjs` — query runner for ad-hoc SQL

## Execution mode

### Step 1 — Query recent spread data
```sql
-- Top divergences in last 24h
SELECT
  ml.canonical_event_id,
  k.external_id AS kalshi_market,
  p.external_id AS poly_market,
  ABS(ks.yes_price - ps.yes_price) AS spread_delta,
  ks.yes_price AS kalshi_price,
  ps.yes_price AS poly_price,
  ks.snapshot_at
FROM pmci.market_links ml
JOIN pmci.provider_markets k ON k.id = ml.kalshi_market_id
JOIN pmci.provider_markets p ON p.id = ml.poly_market_id
JOIN LATERAL (
  SELECT yes_price, snapshot_at FROM pmci.provider_market_snapshots
  WHERE provider_market_id = k.id ORDER BY snapshot_at DESC LIMIT 1
) ks ON true
JOIN LATERAL (
  SELECT yes_price FROM pmci.provider_market_snapshots
  WHERE provider_market_id = p.id ORDER BY snapshot_at DESC LIMIT 1
) ps ON true
WHERE ABS(ks.yes_price - ps.yes_price) > 0.08
ORDER BY spread_delta DESC;
```

### Step 2 — Classify anomaly type
| Pattern | Classification |
|---------|---------------|
| Both prices move together, gap persists | Sustained divergence (noteworthy) |
| One price stale, other updated | Staleness issue (→ HEALTH_MONITOR) |
| Both prices at extremes (0 or 1) | Resolution mismatch |
| Gap appeared suddenly | Breaking news or market manipulation |

### Step 3 — Coverage check
```sql
SELECT
  mf.name,
  COUNT(ml.id) AS link_count
FROM pmci.market_families mf
LEFT JOIN pmci.market_links ml ON ml.family_id = mf.id
GROUP BY mf.id, mf.name
HAVING COUNT(ml.id) = 0;
```
Families with 0 links = coverage gap.

### Step 4 — Produce anomaly report
Natural language summary + SQL evidence. If spread_delta is consistently > 0.08 on a single candidate, flag for human review. Do not recommend trading actions.

## Output format
```
## Anomaly Report

**Run at:** <timestamp>
**Threshold:** spread_delta > 0.08

### Top divergences
| Candidate | Kalshi price | Poly price | Delta | Snapshot |
|-----------|-------------|------------|-------|---------|
| ...       | ...         | ...        | ...   | ...     |

### Classification
<per-candidate classification>

### Coverage gaps
<families with 0 links, if any>

### Confidence notes
<anything uncertain or requiring human review>

### Optional: Drift alerting PR
If divergence is systematic, propose adding a threshold alert in:
- `observer.mjs` — log warning when spread_delta > 0.08
```

## Verification
Anomaly correctly identified with supporting snapshot data and SQL evidence. Human reviews before any action is taken.
