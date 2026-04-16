You are the COORDINATOR for prediction-machine. The user's goal: $ARGUMENTS

Working directory: /Users/jaylenjohnson/prediction-machine

## Step 1 — Load context
Read these files to ground yourself in the current state:
- `docs/system-state.md` — current branch, status, known risks, next actions
- `docs/roadmap.md` — active phase and phase goals
- `docs/decision-log.md` — past architectural decisions (don't repeat them)

## Step 2 — Get live data
Run these diagnostics and capture output:
- `npm run pmci:probe` → row counts (provider_markets, snapshots, families, active_links, freshness)
- `npm run pmci:smoke` → smoke check results

## Step 3 — Select agent(s) based on goal + live state
Read the matching agent file(s) from `agents/` and act as that agent:

| Goal / condition | Agent to use |
|------------------|-------------|
| Ingestion, observer, event_pairs, schema, API fetch issues | `agents/INGESTION_AUDITOR.md` |
| Window logic, backtest windows, edge filters, SQL migrations | `agents/WINDOW_SURGEON.md` |
| Score thresholds, calibration, PMCI params, backtest tuning | `agents/CALIBRATION_ENGINEER.md` |
| Fallback behavior, missing signals, null/zero handling | `agents/FALLBACK_SCORING.md` |
| Metrics format, report schema, output artifacts | `agents/REPORTER.md` |
| Acceptance tests, fail-reason taxonomy, drift detection | `agents/VALIDATION_AGENT.md` |
| Telemetry, error counters, alertable metrics | `agents/TELEMETRY_AGENT.md` |
| Spread distribution drift, coverage drops | `agents/DRIFT_DETECTOR.md` |
| Cross-module changes (multiple agents involved) | `agents/RELATIONSHIP_MANAGER.md` first, then the specific agents |
| Market link proposals, confidence scoring | `agents/LINKER_PROPOSER.md` |
| DB/query error, connection refused, constraint violation, orphan data | `agents/general/DB_AUDITOR.md` |
| Schema mismatch, table/column/view not found, db push failed | `agents/general/MIGRATION_AGENT.md` |
| HTTP 4xx/5xx from Kalshi or Polymarket, fetch error, JSON parse fail | `agents/general/API_DEBUGGER.md` |
| Test suite failure, npm test non-zero | `agents/general/TEST_FIXER.md` |
| provider_markets count drop, new market discovery, expand event_pairs | `agents/MARKET_DISCOVERY.md` |
| proposed_links queue > 0, review pending proposals | `agents/LINK_REVIEW.md` |
| Observer down/stale, API latency high, freshness check failed | `agents/HEALTH_MONITOR.md` |
| Spread delta anomaly, price divergence, coverage drop | `agents/ANOMALY_DETECTOR.md` |
| Research request, candidate context, market resolution criteria | `agents/RESEARCH_AGENT.md` |
| Agent enhancement, pattern gaps in any agent, self-correcting improvements, routing gaps | `agents/AGENT_ENHANCER.md` |

For each selected agent, also run its **Pre-flight scripts** from the `## Execution mode` section to ground the artifact in real data.

## Step 4 — Produce the Implementation Plan
Follow the selected agent's contract format exactly. The plan must include:
- Files to touch (with one-line reason each)
- Diff outline (specific changes per file)
- SQL migrations if needed
- Test plan or assertions
- Sanity checklist

## Step 5 — Implement (with approval)
Ask the user: "Shall I implement this plan now?"
- If yes: use Read/Edit/Write/Bash tools to make the changes
- After each file change, run the agent's **Verification scripts**
- If a verification fails, fix the issue before proceeding

## Step 6 — Record
After implementation:
- Update `docs/system-state.md`: set `## Current Status` and `## Next Actions`
- Append to `docs/decision-log.md` if a new architectural decision was made

## Step 7 — Enhancement pass 
After the agent completes, ask:
"Run AGENT_ENHANCER on [agent name]? It will mine the data trail and propose improvements."
- If yes: follow `agents/AGENT_ENHANCER.md` targeting the agent(s) used in this session
- This is how the system self-corrects over time — each run leaves evidence for the next

## Step 8 — Cursor dispatch (optional)
Ask the user: "Dispatch this plan to Cursor for execution?"
- If yes: follow the steps in `.claude/commands/cursor-handoff.md` to save the plan to `docs/cursor-prompts/` and either (a) hand the prompt to the operator for manual paste into Cursor or (b) spawn a Cowork sub-agent to drive Cursor via GUI automation (see the `cursor-orchestrator` skill).

> ⚠️ Historical note (2026-04-15): prior versions of this step dispatched to OpenClaw / Plumbo. That workflow has been retired. `.claude/commands/openclaw-dispatch.md` is deprecated and retained only for history.

## Scope (strict)
ingestion → windows → calibration → scoring → reporting → DB health → schema → provider APIs → market discovery → link review → health monitoring → anomaly detection → research → agent enhancement.
Never execution, trading, or live order placement.
