# API_DEBUGGER

## Trigger
Fire when:
- HTTP 4xx or 5xx response from Kalshi or Polymarket
- `fetch` error / network timeout to external provider
- JSON parse failure on provider response body
- Rate limit response (HTTP 429, or provider-specific rate limit message)
- Observer logs show `kalshiFetchErrors > 0` or `polymarketFetchErrors > 0`

## Scope
**In scope:**
- External provider API failures (Kalshi, Polymarket)
- Response shape validation (unexpected JSON structure)
- Rate limit detection and backoff strategy
- Retry logic gaps

**Out of scope:**
- Internal PMCI API (→ `agents/HEALTH_MONITOR.md`)
- DB errors from ingestion (→ `agents/general/DB_AUDITOR.md`)
- Schema drift (→ `agents/general/MIGRATION_AGENT.md`)

## Pre-flight
1. Check recent observer logs for fetch error counts:
   ```bash
   npm run start 2>&1 | head -100
   ```
2. If raw response is available (logged), inspect shape vs expected.

## Files to read
- `observer.mjs` — fetch calls, error handling, retry logic
- `lib/pmci-ingestion.mjs` — ingestion pipeline, provider adapters
- `event_pairs.json` — active market slugs being fetched

## Execution mode

### Step 1 — Classify the error
From observer logs or error message:
- **4xx (non-429):** Bad request or auth — check slug format, API key, endpoint URL
- **429:** Rate limit — need backoff / request throttling
- **5xx:** Provider outage — need retry with exponential backoff
- **JSON parse:** Response shape changed — need shape guard

### Step 2 — Locate the fetch call
In `observer.mjs` or `lib/pmci-ingestion.mjs`, find the specific fetch call that failed. Read surrounding error handling.

### Step 3 — Produce PR plan
For each error class, the fix type:
| Error | Fix |
|-------|-----|
| 4xx auth | Check API key env var; validate slug format |
| 429 | Add `sleep(ms)` + retry loop with exponential backoff |
| 5xx | Wrap in try/catch; log + continue (don't crash observer) |
| JSON parse | Add `try { JSON.parse(...) } catch` with shape validation |

Output:
- Files to touch
- Diff outline (specific changes per file)
- Test assertion (mock fetch returning error code → observer continues)

## Output format
```
## API Debug Report

**Provider:** <Kalshi | Polymarket>
**Error class:** <4xx | 429 | 5xx | JSON parse>
**Endpoint:** <URL or slug>
**Root cause:** <1–2 sentences>

### Evidence
<log snippet or response body>

### PR Plan
**Files:**
- `observer.mjs` — <change description>
- `lib/pmci-ingestion.mjs` — <change description>

**Diff outline:**
<specific changes>

### Verification
Run 1 observer cycle:
```bash
npm run start
```
Confirm `kalshiFetchErrors` and `polymarketFetchErrors` = 0 in logs.
```

## Verification
Run one full observer cycle:
```bash
npm run start
```
In logs: `kalshiFetchErrors: 0` and `polymarketFetchErrors: 0`
