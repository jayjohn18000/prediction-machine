# OpenClaw Execution Prompt: E1.5 Remediation — Full Completion
> Generated: 2026-04-09
> Branch: `fix/e1-5-sports-proposer-2026-04-08`
> Orchestrator: Claude Cowork | Executor: Plumbo (OpenClaw)

---

## PMCI Invariants

```
[PMCI invariants: no .env writes; run verify:schema after migrations;
new routes in src/api.mjs only; inactive-guard before bulk market changes;
never skip npm run verify:schema]
```

---

## Situation Summary

E1.1–E1.4 are complete. E1.5 is the only gate blocking E2. The sports proposer
pipeline is fully wired but returns `considered=0` because two upstream blockers
prevent any valid candidates from reaching the proposer:

1. `unknown_sport=38707` — sport-inference is not classifying the majority of
   ingested sports markets. The proposer filters out `sport='unknown'` rows.
2. `stale_active=19222` — markets past their close time are still marked `active`,
   polluting the candidate pool.

The PMCI API on port 3001 is also down (Track B — parallel, non-blocking to E1.5).

Active branch: `fix/e1-5-sports-proposer-2026-04-08` (2 commits ahead of main).
Do NOT merge to main until the A5 gate passes.

---

## Track A — E1.5 Proposer Fix (critical path, blocks E2)

### A1 — Diagnose why `considered=0` (read-only, no edits)

- Read `package.json` to find what script `pmci:propose:sports` maps to
- Read that script (`scripts/review/pmci-propose-links-sports.mjs` or equivalent)
- Find the exact SQL or JS filter that causes `considered=0`
  — check for: `sport != 'unknown'`, non-null sport, required home_team/away_team/game_date
- Report the exact filter condition. No code changes yet.

**Hard gate A1:** Plumbo reports the exact filter causing `considered=0`.

---

### A2 — Fix sport-inference to clear `unknown_sport=38707`

- Read `lib/ingestion/services/sport-inference.mjs` — understand current patterns
- Read `docs/reports/latest-sports-audit-packet.json` — see which titles are falling through
- Run this DB query to sample the unknown-sport titles:
  ```sql
  SELECT title, provider, COUNT(*) ct
  FROM pmci.provider_markets
  WHERE category='sports' AND (sport IS NULL OR sport='unknown')
  GROUP BY title, provider
  ORDER BY ct DESC
  LIMIT 50;
  ```
  (Run via: `npm run pmci:db:query` or via supabase CLI / psql if available)
- Add patterns to `sport-inference.mjs` for the top buckets (focus on patterns
  representing >1% of the 38,707 unknown count)
- After editing, re-run ingestion to reclassify:
  ```bash
  npm run pmci:ingest:sports
  ```
- Then run the audit:
  ```bash
  npm run pmci:audit:sports:packet
  npm run verify:schema
  npm run pmci:smoke
  ```

**Hard gate A2:** `unknown_sport` drops to < 1,000 in the audit packet.
`verify:schema` and `pmci:smoke` still pass.

---

### A3 — Clear stale-active backlog (19,222 rows)

- First run the inactive-guard check (REQUIRED by invariants):
  ```bash
  npm run pmci:check-coverage
  ```
- Check if `scripts/review/pmci-clear-stale-proposals.mjs` or a dedicated
  stale-market script handles this. Read it if it exists.
- Run a dry-run SELECT first (before any UPDATE):
  ```sql
  SELECT COUNT(*) FROM pmci.provider_markets
  WHERE category='sports'
    AND status='active'
    AND close_time IS NOT NULL
    AND close_time < NOW();
  ```
- Only apply the UPDATE after confirming the dry-run count is ~19,222.
  Update:
  ```sql
  UPDATE pmci.provider_markets
  SET status='closed'
  WHERE category='sports'
    AND status='active'
    AND close_time IS NOT NULL
    AND close_time < NOW();
  ```
- Then verify:
  ```bash
  npm run pmci:audit:sports:packet
  npm run pmci:smoke
  ```

**Hard gate A3:** `stale_active=0` in audit packet. `pmci:smoke` still passes.

---

### A4 — Rerun proposer and verify non-zero candidates

```bash
npm run pmci:propose:sports
```

Report exact output: `considered=`, `inserted=`, `rejected=` counts.

**Hard gate A4:** `considered > 0`. If still 0 after A2+A3, dig into the
proposer's sport-field join condition before advancing.

---

### A5 — Sports acceptance gate (E1.5 closeout)

- Run final audit packet:
  ```bash
  npm run pmci:audit:sports:packet
  npm run verify:schema
  npm run pmci:smoke
  ```

**Hard gate A5 (E1.5 complete):**
- `semantic_violations=0`
- `stale_active=0`
- `unknown_sport < 1,000`
- ≥5 accepted cross-platform sports pairs with `status='accepted'` in `market_links`

On pass: commit all changes on the active branch:
```
fix(E1.5): fix sport-inference patterns + clear stale-active backlog

- Expanded sport-inference patterns in sport-inference.mjs to classify previously
  unknown sports markets (unknown_sport: 38707 → <1000)
- Cleared 19,222 stale-active sports markets past their close_time
- Sports proposer now returns considered > 0 with semantic_violations=0
- E1.5 acceptance gate passed: ≥5 cross-provider sports links accepted

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

Then update `docs/system-state.md` with today's verified results (phase E1.5 ✓ complete,
E2 unblocked). Report all final counts back to Claude.

---

## Track B — PMCI API Port 3001 Recovery (parallel with A)

Run in parallel with Track A — does not block E1.5 gate.

### B1 — Diagnose and restart

- Check: `cat package.json | grep "api:pmci"`
- Start the PMCI API: `npm run api:pmci`
- Watch startup logs for port binding errors or crash reason
- Report first 30 lines of startup output

**Hard gate B1:** Port 3001 has a listener AND `/v1/health/slo` returns HTTP 200.
Check: `lsof -iTCP:3001 -sTCP:LISTEN -n -P` and `curl -s http://localhost:3001/v1/health/slo`

### B2 — If B1 startup fails

- Read last 50 lines of startup stderr for crash message
- Check: missing env var, port conflict, or Fastify boot error
- Fix the specific error (do NOT edit `.env` — print proposed changes to stdout only)
- Rerun B1

---

## Track C — Live Audit Script (hygiene, non-blocking)

Create `scripts/run_pmci_live_audit.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== PMCI LIVE AUDIT $(date -u '+%Y-%m-%dT%H:%M:%SZ') ==="
echo ""

echo "--- Schema ---"
npm run verify:schema

echo ""
echo "--- Smoke ---"
npm run pmci:smoke

echo ""
echo "--- API Port 3001 ---"
lsof -iTCP:3001 -sTCP:LISTEN -n -P 2>/dev/null && echo "PORT_3001_LISTENING" || echo "PORT_3001_NOT_LISTENING"
curl -s --max-time 3 http://localhost:3001/v1/health/slo 2>/dev/null | head -c 300 || echo "API_UNREACHABLE"

echo ""
echo "--- Sports Proposer ---"
npm run pmci:propose:sports 2>&1 | tail -5

echo ""
echo "--- Sports Audit Packet ---"
npm run pmci:audit:sports:packet 2>&1 | tail -10

echo ""
echo "=== AUDIT COMPLETE ==="
```

- `chmod +x scripts/run_pmci_live_audit.sh`
- Add to `package.json` scripts: `"pmci:audit:live": "bash scripts/run_pmci_live_audit.sh"`
- Test it: `npm run pmci:audit:live`

**Hard gate C1:** Script runs without error, produces all 5 audit sections.

---

## Final Verification Sequence (run after A5 + B1 + C1 pass)

```bash
npm run verify:schema
npm run pmci:smoke
npm run pmci:audit:sports:packet
bash scripts/run_pmci_live_audit.sh
curl -s http://localhost:3001/v1/health/slo
```

All must pass before the branch is merged to main. Report all output back to Claude.

---

## Reference Files (Plumbo reads these — do not paste contents here)

- `/Users/jaylenjohnson/prediction-machine/package.json`
- `/Users/jaylenjohnson/prediction-machine/lib/ingestion/services/sport-inference.mjs`
- `/Users/jaylenjohnson/prediction-machine/scripts/review/pmci-propose-links-sports.mjs`
- `/Users/jaylenjohnson/prediction-machine/scripts/review/pmci-clear-stale-proposals.mjs`
- `/Users/jaylenjohnson/prediction-machine/docs/reports/latest-sports-audit-packet.json`
- `/Users/jaylenjohnson/prediction-machine/docs/system-state.md`
- `/Users/jaylenjohnson/prediction-machine/docs/roadmap.md`
