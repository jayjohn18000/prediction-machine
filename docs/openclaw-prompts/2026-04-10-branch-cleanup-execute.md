# OpenClaw Execution Prompt: Branch Cleanup — Post E1.5
> Generated: 2026-04-10
> Branch: main (all work happens on main; no branch switching needed)

## Context
E1.5 is complete and merged to main. A full read-only audit confirmed:
- All 4 local stale branches have 0 unique commits (fully merged)
- All 6 remote cursor branches have been superseded or rewritten in main
- git cherry confirmed none were cherry-picked; all were rewritten
- Safe to delete all 10 branches in one pass

## Execution

### Step 1 — Clear any stale git lock files (safety first)
```bash
cd ~/prediction-machine
rm -f .git/index.lock .git/HEAD.lock
```

### Step 2 — Delete all 4 local stale branches
```bash
cd ~/prediction-machine
git branch -d fix/e1-5-sports-proposer-2026-04-08
git branch -d fix/runtime-status-infra-2026-04-04
git branch -d fix/review-idempotent-atomic-2026-03-08
git branch -d fix/kalshi-liveness-matching-20260308
```
Note: use -d (safe delete). If any fail with "not fully merged", use -D and note it.

### Step 3 — Delete all 6 remote cursor branches
```bash
cd ~/prediction-machine
git push origin --delete cursor/sport-inference-tests-backfill-845e
git push origin --delete cursor/kalshi-sport-fallback-patterns-a491
git push origin --delete cursor/polymarket-sport-inference-logic-e736
git push origin --delete cursor/sports-universe-runtime-hardening-618c
git push origin --delete cursor/db-pool-error-handling-ed16
git push origin --delete cursor/python-hello-world-b78d
```

### Step 4 — Prune remote tracking refs
```bash
cd ~/prediction-machine
git remote prune origin
```

### Step 5 — Verify final branch state
```bash
cd ~/prediction-machine
git branch -a
```
Expected result: only `main` and `remotes/origin/main` remain.

## What to return
Return the full output of every command. Note any errors or unexpected results.
Do NOT commit anything. Do NOT modify any files.
