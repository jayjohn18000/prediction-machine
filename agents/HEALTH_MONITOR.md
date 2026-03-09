# HEALTH_MONITOR

## Trigger
Fire when:
- Observer last cycle > 5 minutes ago
- API p95 latency > 500ms
- `npm run pmci:watch` exits non-zero
- `/v1/health/freshness` returns stale
- Human reports "observer is down" or "API is slow"

## Scope
**In scope:**
- Observer uptime and cycle freshness
- PMCI API response latency (p95)
- Freshness check (`/v1/health/freshness`)
- Restart guidance for observer
- Diagnosing API latency regressions

**Out of scope:**
- Data quality within snapshots (→ `agents/general/DB_AUDITOR.md`)
- Provider API failures during ingestion (→ `agents/general/API_DEBUGGER.md`)

## Pre-flight
```bash
npm run pmci:watch
curl -s localhost:8787/v1/health/freshness | jq .
```
Note: freshness timestamp, p95 latency, observer last-seen.

## Files to read
- `observer.mjs` — observer loop, cycle timing, shutdown signals
- `src/api.mjs` — Fastify routes, latency instrumentation
- `scripts/pmci-watch.mjs` — freshness check logic and thresholds

## Execution mode

### Step 1 — Assess observer status
From `pmci:watch` output:
- If stale: observer process is down → restart
- If fresh but p95 high: observer is running, API is slow → Step 3

### Step 2 — Restart observer (if down)
```bash
npm run start
```
Wait 2 cycles, then:
```bash
npm run pmci:watch   # Should exit 0
```

### Step 3 — Diagnose API latency (if p95 > 500ms)
Check `/v1/health/freshness` response for:
- `p95_ms` value
- Which route is slow (check Fastify logs or add timing)

Common causes:
| Cause | Fix |
|-------|-----|
| Missing DB index on snapshots | Add index migration |
| View `v_market_links_current` expensive | Materialize or add index |
| Fastify not using connection pool | Check `src/db.mjs` pool config |

Produce a PR plan with:
- Root cause
- Files to touch
- Diff outline
- Expected p95 after fix

## Output format

### Observer down
```
## Health Report — Observer Down

**Last cycle:** <timestamp>
**Staleness:** <N> minutes

### Restart plan
```bash
npm run start
```
After 2 cycles:
```bash
npm run pmci:watch   # Must exit 0
```
```

### API latency
```
## Health Report — API Latency

**Current p95:** <N>ms (target: 500ms)

**Root cause:** <description>

### PR Plan
**Files:**
- `<file>` — <change>

**Diff outline:**
<changes>

### Verification
```bash
curl -s localhost:8787/v1/health/freshness | jq .p95_ms
# Must be < 500
```
```

## Verification
```bash
npm run pmci:watch
# Must exit 0

curl -s localhost:8787/v1/health/freshness | jq .p95_ms
# Must be < 500
```
