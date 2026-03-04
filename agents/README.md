# Agents — Persistent prompt pack

Reusable agent prompts for the prediction-machine pipeline. Each file is **run as a separate step**; only **COORDINATOR** is run every session. Agents produce **contract outputs** (PR plans, SQL migrations, test plans, metrics/report format, sanity checklists) that the Coordinator merges into one Implementation Plan.

**Scope:** ingestion → windows → calibration → scoring → reporting. **No** execution or trading.

---

## Which tool to use

| Task | Tool | Why |
|------|------|-----|
| Planning sessions, multi-file implementation | **Cursor** | Flat $20/month, Composer + `@file` references, great for edits |
| Operational loops (status, review queue, diagnostics) | **Claude Code** | Full shell access, runs scripts, acts on output |

---

## How to run in Cursor (planning + implementation)

`.cursor/rules` injects project context automatically — no manual paste needed.

### 1. Start with the Coordinator

In Composer, reference: `@agents/COORDINATOR.md`

Tell it your goal. It decides which agent to run next.

### 2. Run one agent at a time

Reference the agent file (e.g. `@agents/WINDOW_SURGEON.md`) and pass the context.
Each agent’s `## Execution mode` section lists which terminal commands to run first.

### 3. Feed output back to the Coordinator

Paste the artifact into Composer and reference `@agents/COORDINATOR.md` again.
It merges the artifact into the Implementation Plan.

### 4. Implement

Use the final Implementation Plan in Cursor Composer. Run verification scripts
from the agent’s `## Execution mode` section when done.

---

## How to run in Claude Code (operational workflows)

Use the slash commands in `.claude/commands/`:

| Command | What it does |
|---------|-------------|
| `/coordinate "goal"` | Runs COORDINATOR loop with live DB data; can implement the plan |
| `/pmci-status` | DB counts + freshness + API health in one report |
| `/pmci-review` | Interactive review queue (accept/reject/skip proposals) |
| `/pmci-cycle` | Full diagnostic + routes to next action |

---

## Agent list

| Agent | Purpose | Typical output |
|-------|--------|----------------|
| **COORDINATOR** | Orchestrate order and merge | "Run X next" or "Plan ready" |
| **RELATIONSHIP_MANAGER** | Dependencies, scope, schema alignment | Dependency map, guardrails |
| **INGESTION_AUDITOR** | Data sources, schemas, event_pairs, observer | PR plan, sanity checklist |
| **WINDOW_SURGEON** | Edge windows, filters, backtest windows | PR plan, SQL migration |
| **CALIBRATION_ENGINEER** | Thresholds, PMCI params, score mapping | PR plan, test plan |
| **FALLBACK_SCORING** | Fallback when signals missing | PR plan, test plan |
| **REPORTER** | Metrics, report format, outputs | Report schema, sanity checklist |
| **VALIDATION_AGENT** | Acceptance tests, fail reasons, drift/cohort | Test plan, taxonomy, checks |
| **TELEMETRY_AGENT** | Error taxonomy, alertable counters (Phase B) | Metrics spec, PR plan |
| **DRIFT_DETECTOR** | Spread distribution drift, coverage drops | Drift check spec, SQL queries |

---

## Contract types (what each agent can output)

- **PR plan** — Files touched + diff outline
- **SQL migration** — Migration file spec + SQL or body
- **Test plan + assertions** — What to test, expected outcomes, regression
- **Metrics/report format** — Schema, example, when produced
- **Sanity checklist** — Bullet list of checks before calling done

The Coordinator merges these into one **Implementation Plan**.
