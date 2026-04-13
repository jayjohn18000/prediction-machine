# OpenClaw Read-Only Task: Branch Cleanup Validation
> Generated: 2026-04-10
> Branch: main (read-only — no commits, no file changes)

## Context
E1.5 is complete and merged to main as of 2026-04-10. Claude has done a full git audit of all
local and remote branches. This is a READ-ONLY validation pass. Plumbo must NOT commit anything,
delete any branches, or modify any files. Return all output as text.

## What Claude already found (do not re-derive — just verify)

### Local branches — all 0 unique commits ahead of main
- fix/e1-5-sports-proposer-2026-04-08      → 0 ahead, 2 behind
- fix/runtime-status-infra-2026-04-04      → 0 ahead, 7 behind
- fix/review-idempotent-atomic-2026-03-08  → 0 ahead, 38 behind
- fix/kalshi-liveness-matching-20260308    → 0 ahead, 57 behind

### Remote cursor branches — each 1 unique commit ahead of main, 28 behind
- cursor/sport-inference-tests-backfill-845e   → bcaa87c
- cursor/kalshi-sport-fallback-patterns-a491   → e0eaa01
- cursor/polymarket-sport-inference-logic-e736 → 47b63be
- cursor/sports-universe-runtime-hardening-618c → d8280ba
- cursor/db-pool-error-handling-ed16           → 87963ab
- cursor/python-hello-world-b78d               → fa769bf

## Validation tasks (READ ONLY — return all output as text)

### V1 — Confirm local branches are fully merged
```bash
cd ~/prediction-machine
for branch in fix/e1-5-sports-proposer-2026-04-08 fix/runtime-status-infra-2026-04-04 fix/review-idempotent-atomic-2026-03-08 fix/kalshi-liveness-matching-20260308; do
  ahead=$(git rev-list --count main..$branch 2>/dev/null)
  behind=$(git rev-list --count $branch..main 2>/dev/null)
  echo "$branch | ahead=$ahead | behind=$behind"
done
```
Expected: all `ahead=0`. Confirm yes/no.

### V2 — Confirm cursor branch unique commits are NOT cherry-picked into main
For each of these commit SHAs, check if the PATCH (not the SHA) is already present in main history:
- bcaa87c (sport-inference-tests-backfill-845e)
- e0eaa01 (kalshi-sport-fallback-patterns-a491)
- 47b63be (polymarket-sport-inference-logic-e736)
- d8280ba (sports-universe-runtime-hardening-618c)
- 87963ab (db-pool-error-handling-ed16)
- fa769bf (python-hello-world-b78d)

Run:
```bash
cd ~/prediction-machine
for sha in bcaa87c e0eaa01 47b63be d8280ba 87963ab fa769bf; do
  result=$(git cherry main $sha 2>/dev/null | head -1)
  echo "$sha: $result"
done
```
`+` means NOT in main (unique), `-` means patch already in main. Return the raw output.

### V3 — Check whether specific files from cursor branches are superseded in main

Claude found these key discrepancies. Verify each:

**3a. tests/sport-inference.test.mjs** — does this file exist in main?
```bash
cd ~/prediction-machine && git show main:tests/sport-inference.test.mjs 2>/dev/null | wc -l || echo "NOT IN MAIN"
```

**3b. scripts/ingestion/pmci-backfill-sport-codes.mjs** — does this file exist in main?
```bash
cd ~/prediction-machine && git show main:scripts/ingestion/pmci-backfill-sport-codes.mjs 2>/dev/null | wc -l || echo "NOT IN MAIN"
```

**3c. hello.py** — does this file exist in main?
```bash
cd ~/prediction-machine && git show main:hello.py 2>/dev/null | wc -l || echo "NOT IN MAIN"
```

**3d. db-pool fix** — is main's version of src/platform/db.mjs MORE complete than the cursor branch version (87963ab)?
```bash
cd ~/prediction-machine
echo "=== main ==="
git show main:src/platform/db.mjs | grep -A5 "pool.on"
echo "=== cursor branch ==="
git show 87963ab:src/platform/db.mjs | grep -A5 "pool.on"
```

**3e. sport-inference.mjs approach** — confirm main uses KALSHI_TICKER_MAP regex approach (not the older TAG_TO_SPORT_CODE Map approach from cursor branches):
```bash
cd ~/prediction-machine
git show main:lib/ingestion/services/sport-inference.mjs | head -15
```

### V4 — Confirm no other branches exist that Claude missed
```bash
cd ~/prediction-machine && git branch -a
```
Return the full list.

## What to return
Return all raw command output in full. Do not summarize — Claude will interpret.
Do NOT commit, delete branches, or modify any files.
