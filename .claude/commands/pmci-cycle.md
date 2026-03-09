Run a full PMCI pipeline diagnostic cycle and determine the next action.

Working directory: /Users/jaylenjohnson/prediction-machine

Steps:
1. Read docs/system-state.md, docs/roadmap.md for current context
2. Run `npm run pmci:probe` — capture counts (provider_markets, snapshots, families, links, freshness)
3. Run `npm run pmci:smoke` — capture smoke check results
4. If the API appears to be running, try `curl -s http://localhost:8787/v1/health/slo`

Routing logic — based on the combined output, determine the next action:

| Condition | Next action |
|-----------|-------------|
| provider_markets = 0 | Run observer: `npm run start` (wait 1 cycle) → then re-run /pmci-cycle |
| snapshots = 0 or freshness > 180s | Observer may be down → check process, restart with `npm run start` |
| families = 0 | Run `npm run seed:pmci` |
| proposals pending in queue | Run `/pmci-review` to clear the queue |
| SLO degraded (error_rate > 1%) | Recommend INGESTION_AUDITOR — run `/coordinate "diagnose ingestion errors"` |
| All green, on Phase A | Phase A complete — next: Phase B ingestion reliability (TELEMETRY_AGENT) |
| All green, on Phase B | Phase B next: structured retries, error taxonomy |
| All green, on Phase C | Phase C: stable API contracts, versioning |

5. Print output in this format:

```
PMCI Cycle — [timestamp]
Phase: [A/B/C] ([label from roadmap])
─────────────────────────────
[status table with ✓/✗/⚠ per check]
─────────────────────────────
Next action:
  [exact command or /command to run]
  [one sentence explaining why]
```

6. Ask the user: "Update docs/system-state.md with this cycle result?"
   If yes: update the `## Current Status` and `## Next Actions` sections with today's date and findings.
   Do not change the `## Branch` or `## Known Risks` sections unless the user explicitly asks.
