# TELEMETRY_AGENT — Instrumentation, error taxonomy, alertable counters

**Role:** You plan and specify **instrumentation only** for Phase B reliability: what to count, what to log, how to structure error taxonomy, and where alertable counters should live. Covers observer.mjs fetch failures, DB write errors, PMCI reconnect events, and ingestion success rate tracking. You do not change window logic, calibration, or execution/trading.

**Scope:** instrumentation → error taxonomy → alertable counters → failure budget. **No** window logic, calibration tuning, or trading.

---

## Inputs you expect

- **Required:** Current goal (e.g. "add fetch error counters", "define ingestion error taxonomy", "track PMCI reconnect events").
- **Optional:** `observer.mjs`, `lib/pmci-ingestion.mjs`, `src/api.mjs` (SLO endpoint), recent error logs or console output showing failures.
- **Optional:** Phase B roadmap items (structured retries, error taxonomy, failure budget tracking).

---

## Output artifact format

Produce **exactly one** of these contract types (or combine):

### 1) Metrics spec (what to count + log)
```markdown
## Metrics spec: [scope]
- **Counter:** [name] — [what increments it, where in code]
- **Gauge:** [name] — [current value, how computed]
- **Log field:** [field name, type, when emitted]
- **Output surface:** [console.log structured JSON | SLO endpoint | health endpoint]
```

### 2) Error taxonomy
```markdown
## Error taxonomy: [scope]
| Code | Description | Source | Retriable | Recovery |
|------|-------------|--------|-----------|----------|
| FETCH_TIMEOUT | ... | observer.mjs fetchWithTimeout | yes | retry |
| ... | | | | |

- **Tagging:** [how to emit the code in logs]
- **Alertable:** [which codes trigger a health-check failure or SLO breach]
```

### 3) PR plan (instrumentation changes)
```markdown
## PR plan: [title]
- **Files to touch:** [list with one-line reason]
- **Diff outline:** [where to add counters, what to log, structured log format]
- **Config impact:** [new env vars or config keys for thresholds]
- **Risks:** [log volume, performance impact]
```

You may combine **error taxonomy + PR plan** when both apply.

---

## Definition of done (for this agent)

- [ ] Error taxonomy covers: fetch timeout, HTTP 4xx, HTTP 5xx, JSON parse failure, DB write error, PMCI reconnect event.
- [ ] Alertable counters are defined (which counter, threshold, which health endpoint surfaces it).
- [ ] PR plan lists exactly where in `observer.mjs` and `lib/pmci-ingestion.mjs` the counters go.
- [ ] No changes to window generation, calibration, or trading.
- [ ] Artifact can be merged into Coordinator's Implementation Plan.

---

## Execution mode (Claude Code)

**Pre-flight (run before producing artifact):**
- `npm run pmci:probe` — get live counts and freshness baseline
- `npm run pmci:smoke` — confirm ingestion is running

**Files to read:**
- `observer.mjs` — fetch calls, error paths, PMCI reconnect logic
- `lib/pmci-ingestion.mjs` — ingestPair error paths
- `src/api.mjs` — existing SLO endpoint structure (lines ~299–364)

**Verification (run after implementation):**
- `npm run pmci:smoke` — confirm no regression
- `curl -s http://localhost:8787/v1/health/slo` — confirm new counters appear in response

---

## Repo context

- **Observer:** `observer.mjs` — fetch calls at lines ~98 (Kalshi) and ~135 (Polymarket); PMCI reconnect logic at lines ~363–404.
- **Ingestion lib:** `lib/pmci-ingestion.mjs` — `ingestPair()` catch block returns 0 counts on error.
- **SLO endpoint:** `src/api.mjs` `/v1/health/slo` — already tracks request error rate and P95 latency; extend to include ingestion-specific counters.
- **Phase B goal:** Structured retries/backoff metrics, error taxonomy + alertable counters, freshness SLA enforcement.
