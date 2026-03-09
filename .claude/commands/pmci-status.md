Run a full PMCI status check for prediction-machine.

Working directory: /Users/jaylenjohnson/prediction-machine

Steps:
1. Run `npm run pmci:probe` and capture full output
2. Run `npm run pmci:smoke` and capture full output
3. Try `curl -s http://localhost:8787/v1/health/projection-ready` — if the API isn't running, note that it's offline
4. Print a consolidated status report using this format:

```
PMCI Status — [timestamp]
─────────────────────────────
DB Counts
  ✓/✗  provider_markets: [N]
  ✓/✗  snapshots: [N]
  ✓/✗  families: [N]
  ✓/✗  active_links: [N]
  ✓/✗  freshness_lag: [N]s

API (projection-ready): [ok/offline/not-ready]
─────────────────────────────
WARNINGS / ERRORS:
  [list any WARN or ERROR lines from scripts]

FIX:
  [for each failing check, print the exact npm command to resolve it]
```

Mark each check with ✓ (pass) or ✗ (fail).
Critical failures (provider_markets = 0, no DB connection) get ✗.
Warnings (stale data, no families) get ⚠.

This is a read-only diagnostic. Do not modify any files.
