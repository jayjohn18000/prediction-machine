# Phase E1–E1.5 Validation Status

Created: 2026-04-04 20:19 CDT
Mode: Read-only validation (no code changes)
Repo: `~/prediction-machine`

## Overall Status

- **E1.1–E1.4:** mostly real and present in codebase
- **E1.5:** **not complete in this 2026-04-04 validation snapshot**
- **Runtime health right now:** ingestion/freshness are healthy, but **API p95 latency is degraded**
- **Repo state:** there are uncommitted local modifications, so current file state may be ahead of last documented checkpoints

> Historical note added 2026-04-09: this document is an April 4 validation snapshot, not the current source of truth. Later live audit evidence showed the repo had advanced, including wired `seed:sports:pmci`, `pmci:propose:sports`, and `pmci:audit:sports:packet` scripts plus branch-local E1.5 work on `fix/e1-5-sports-proposer-2026-04-08`. A same-day rerun at 18:27-18:28 UTC reconfirmed proposer `considered=0 inserted=0` and strict-audit `semantic_violations=0 / stale_active=19222 / unknown_sport=38707`.
>
> Historical note added 2026-04-10: E1.5 branch-local work referenced above has since merged to `main` (commit `cad1f9a`). Current-state smoke evidence moved to `provider_markets=76587 / snapshots=672374 / families=3120 / current_links=131` via post-edit `npm run pmci:smoke` rerun. Keep this file as a point-in-time snapshot only; use `docs/roadmap.md` and `docs/system-state.md` for current state.

---

## Evidence Log

### 1) Repo state

**Command**
```bash
git status --short --branch
```

**Result**
```text
## main...origin/main [ahead 10]
 M docs/roadmap.md
 M lib/ingestion/services/sport-inference.mjs
 M src/platform/db.mjs
 M src/server.mjs
?? docs/phase-e1-5-sport-inference-and-runtime-plan.md
?? docs/phase-e1-5-sport-inference-and-runtime-schema.md
```

**Interpretation**
- The repo had **local, uncommitted changes** at the time of this snapshot
- That matters because roadmap text may not match committed implementation yet
- Historical note added 2026-04-09: this caveat turned out to matter; later audits confirmed implementation moved ahead of several April 4 documentation claims

---

## Phase-by-Phase Status

## E1.1 — Schema migration
**Status: PASS**

**Command**
```bash
ls -1 supabase/migrations/*sports_market_fields.sql supabase/migrations/*snapshot_retention.sql
```

**Result**
```text
supabase/migrations/20260331000001_sports_market_fields.sql
supabase/migrations/20260331000002_snapshot_retention.sql
```

**Validation**
- Sports field migration exists
- Snapshot retention migration exists

**Conclusion**
- **E1.1 is genuinely complete**

---

## E1.2 — Sports ingestion wiring + sport inference base
**Status: PASS, but partially drifted from E1.5 expectations**

**Command**
```bash
grep -n "fetchPolymarketSportsTagsFromSportsEndpoint\|inferSportFromPolymarketTags\|category='Sports'\|category === 'Sports'\|closed=false&archived=false\|outcomePrices\|clobTokenIds\|isLive" lib/ingestion/sports-universe.mjs
```

**Result highlights**
```text
158: // Filter by category === 'Sports'
264: async function fetchPolymarketSportsTagsFromSportsEndpoint() {
348: closed=false&archived=false
365: const sport = inferSportFromPolymarketTags(tagSlugs);
376-390: outcomePrices / clobTokenIds JSON.parse handling
394-405: isLive and status mapping
```

**Interpretation**
- Kalshi sports category filter exists
- Polymarket `/sports` endpoint integration exists
- E1.4 parsing fixes exist
- But current code still does:
```js
const sport = inferSportFromPolymarketTags(tagSlugs);
```
instead of using the `/sports` endpoint label directly

**Conclusion**
- **Base E1.2 is present**
- But the specific **E1.5 Polymarket inference hardening is not applied**

---

## E1.3 — Proposer hardening
**Status: PASS**

**Command**
```bash
grep -n "title_similarity < 0.30\|slug_similarity < 0.20\|close_time > NOW()\|pmci-clear-stale-proposals\|market_links" lib/matching/proposal-engine.mjs scripts/review/pmci-clear-stale-proposals.mjs package.json
```

**Result highlights**
```text
lib/matching/proposal-engine.mjs:384 AND (close_time IS NULL OR close_time > NOW())
lib/matching/proposal-engine.mjs:391 AND (close_time IS NULL OR close_time > NOW())
lib/matching/proposal-engine.mjs:899 SELECT 1 FROM pmci.market_links ...
lib/matching/proposal-engine.mjs:974 if (reasons.title_similarity < 0.30 && (reasons.slug_similarity ?? 0) < 0.20)
scripts/review/pmci-clear-stale-proposals.mjs: exists
package.json: pmci:clear:stale exists
```

**Conclusion**
- **E1.3 is genuinely complete**

---

## E1.4 — Polymarket sports ingestion fix
**Status: PASS**

**Evidence already found in `sports-universe.mjs`**
- `closed=false&archived=false`
- `outcomePrices` parsed from stringified JSON
- `clobTokenIds` parsed from stringified JSON
- `isLive ? "active" : "closed"`

**Conclusion**
- **E1.4 is genuinely complete**

---

## E1.5 — Sport inference fix + runtime hardening
**Status: FAIL / incomplete**

### E1.5 artifact existence

**Command**
```bash
for f in lib/ingestion/services/sport-inference.mjs tests/sport-inference.test.mjs scripts/ingestion/pmci-backfill-sport-codes.mjs; do
  if [ -f "$f" ]; then echo "FOUND $f"; else echo "MISSING $f"; fi
done
```

**Result**
```text
FOUND lib/ingestion/services/sport-inference.mjs
MISSING tests/sport-inference.test.mjs
MISSING scripts/ingestion/pmci-backfill-sport-codes.mjs
```

### E1.5 code probes

**Command**
```bash
node - <<'NODE'
...file probes...
NODE
```

**Result**
```text
sports-universe has normalizePolymarketSportLabel: NO
sports-universe uses tagSlug primary sport mapping: NO
sports-universe has MAX_RUNTIME_MS: NO
sports-universe has seriesRecentlySeen: NO
sport inference has CS2 fallback: YES
sport inference has LIGAMX fallback: NO
sport inference has broad KX.*MLB fallback: NO
```

**Interpretation**

### Present
- `sport-inference.mjs` exists
- At least some fallback expansion has started (`CS2` present)

### Missing
- No `normalizePolymarketSportLabel()`
- No primary use of `tagSlug` from `/sports`
- No runtime ceiling (`MAX_RUNTIME_MS`)
- No incremental skip (`seriesRecentlySeen`)
- No unit test file
- No backfill script
- No broad MLB fallback
- No Liga MX fallback

**Conclusion**
- **E1.5 is not complete**
- At best, it is **partially started**

---

## Runtime Validation

### Syntax check

**Command**
```bash
node --check lib/ingestion/sports-universe.mjs lib/ingestion/services/sport-inference.mjs
```

**Result**
- No output
- Exit success

**Conclusion**
- These two files are syntactically valid

---

### Schema validation

**Command**
```bash
npm run verify:schema
```

**Result**
```text
PMCI schema verification: PASS
```

**Conclusion**
- Schema is healthy

---

### Smoke validation

**Command**
```bash
npm run pmci:smoke
```

**Result**
```text
provider_markets: 66423
snapshots: 230591
families: 72
current_links (v_market_links_current): 124
```

**Conclusion**
- PMCI core data plane is healthy
- Sports expansion has clearly accumulated substantial data

---

### Watch / freshness validation

**Command**
```bash
npm run pmci:watch
```

**Observed output**
```text
pmci:watch status=ok lag=5 ...
pmci:watch status=ok lag=22 ...
pmci:watch status=ok lag=6 ...
```

**Conclusion**
- Freshness is healthy
- Ingestion is actively writing snapshots during validation

---

### Projection status

**Command**
```bash
npm run pmci:status
```

**Result**
```text
✓ Freshness ok (lag: 4s)
✓ Projection ready
⚠ SLO degraded
✗ api_p95_latency_ms: actual=774 target=500
```

**Conclusion**
- System is operational
- But **performance gate is currently failing**
- This is real, not just reporting drift

---

## What Appears Inaccurately Reflected Right Now

### Likely overstated as complete
- **E1.5**
  - Docs exist
  - Some `sport-inference.mjs` work has started
  - But the planned implementation is **not actually complete**

### Likely understated / should count as complete
- **E1.1**
- **E1.3**
- **E1.4**
- Core operational health:
  - schema passes
  - smoke passes
  - freshness/watch passes
  - projection ready passes

### Real failing status, not false negative
- **api_p95_latency target**
  - Current status script reports **774ms vs target 500ms**
  - That is a genuine failing gate based on current runtime check output

---

## Current Phase Summary

- **E1.1:** Complete
- **E1.2:** Complete for ingestion wiring
- **E1.3:** Complete
- **E1.4:** Complete
- **E1.5:** Incomplete / partial only

### Practical readout
You are **past E1.4 operationally**.
You are **not actually done with E1.5** yet.
