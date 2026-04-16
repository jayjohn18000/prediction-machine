# PMCI Agentic Workflow Optimization Plan

_Decided: 2026-04-10, based on Phase E1.5 session retrospective_
_Amended: 2026-04-15 — OpenClaw/Plumbo retired; Cursor is now the primary code executor. See `DEV_WORKFLOW.md`._

> ⚠️ Amendment (2026-04-15): the agent-role decision below (Decision 4) originally split work between Claude Cowork and Plumbo/OpenClaw. That split still holds, but **read every mention of "Plumbo" or "OpenClaw" in this doc as "Cursor"** — driven either manually or by a Cowork sub-agent via GUI automation (see the `cursor-orchestrator` skill). The rationale (preserving Cowork context for orchestration; keeping the executor's context focused on diffs) is unchanged.

---

## Decision 1 — Long-running process pattern

**Use Desktop Commander `start_process` + `read_process_output` as the standard pattern.**

Do not switch to OpenClaw API pings (hypothetical only — Desktop Commander works and is the right tool). Do not use `osascript` polling loops; they consume significant context window per iteration and introduce AppleScript quoting fragility.

**Rule:** When a job is expected to exceed ~90 seconds, start it with DC `start_process` redirecting stdout/stderr to `/tmp/<job-name>.log`. Confirm completion with a single `read_process_output` call (or tail the log file). Never poll in a loop — one read after the process exits is sufficient.

---

## Decision 2 — Schema documentation

**Create `docs/db-schema-reference.md` and reference it from `CLAUDE.md`.**

The E1.5 session lost multiple tool-call cycles to column-not-found errors, wrong header names, and integer-as-string type mismatches that are not derivable from reading the code alone. A dedicated reference doc prevents this.

The reference doc captures:
- Actual column names for `proposed_links`, `market_links`, `provider_markets`, `families`
- Provider ID type quirk: pg returns integer columns as JS strings; always wrap with `Number()` before comparing
- Upsert COALESCE behavior: `COALESCE(EXCLUDED.sport, provider_markets.sport)` means re-ingestion with a non-null sport will update previously-unknown rows
- Correct auth header: `x-pmci-api-key` (not `x-pmci-admin-key`) for all `/v1/review/*` endpoints
- The proposed_links → market_links acceptance flow step-by-step

`CLAUDE.md` Key Entrypoints section includes:
```
- docs/db-schema-reference.md — DB column reference and API auth; read at session start before any DB queries or API calls
```

---

## Decision 3 — Acceptance flow as npm script

**Add `pmci:accept:sports` to `package.json` wrapping `reset-and-accept-valid-sports.mjs`.**

The acceptance flow (reset rejected → re-validate → POST to API) was assembled ad-hoc during E1.5 and required multiple iterations to get right. It should be a named, runnable script so the gate loop is repeatable in one call.

The script must include guard logic: only accept proposals that currently pass `isSportsPairSemanticallyValid` at time of run, so stale or semantically-wrong pairs are never promoted.

---

## Decision 4 — Agent role split (nuanced rule)

**Cursor for 3+ files or careful diffs; Claude directly for single-file fixes and config.**

_Amended 2026-04-15: OpenClaw/Plumbo retired; Cursor is the sole non-Cowork executor. Cursor may be driven manually by the operator or by a Cowork sub-agent via GUI automation (see `cursor-orchestrator` skill) — the latter is preferred when the main Cowork session's context is saturated._

| Task type | Executor |
|-----------|----------|
| Change touching 3+ files | Cursor |
| Schema migration | Cursor |
| Multi-file refactor requiring careful diffs | Cursor |
| Single-file fix | Claude (Cowork) |
| Config / env / package.json change | Claude (Cowork) |
| Shell / git / API operations | Claude (Cowork) |
| Orchestration, approval, review | Claude (Cowork) |

**Rationale:** Preserves Claude's context window for orchestration tasks. Cursor's context stays focused on code changes where its diff awareness is highest-value. Do not send Cursor tasks that require reading 10+ files just to make a one-line change. When Cowork's context is already high, spawn a fresh sub-agent to drive Cursor instead of continuing in the main session.

---

## Decision 5 — Scheduled ingestion lock conflict

**Wait-and-retry is correct. Never kill the running job.**

If a manual run is needed while a scheduled ingestion is active:
1. Poll the PID (via `ps` or Desktop Commander process list) until it exits
2. Then run the manual job

The codebase is upsert-safe throughout — there is no data integrity risk from two runs overlapping or running back-to-back. The wait adds at most 10–15 minutes but avoids any partial-write risk and keeps the scheduler state clean.

---

## Decision 6 — Single-command gate verification

**Extend `pmci:audit:live` (or create `pmci:gate:sports`) to emit a single PASS/FAIL verdict.**

The E1.5 gate required ~10 separate tool calls to verify all five criteria. At phase-end this is pure overhead.

The gate script should:
- Check all criteria for the active phase (e.g., E1.5: `stale_active=0`, `unknown_sport<1000`, `semantic_violations=0`, `verify:schema PASS`, `≥5 accepted pairs`)
- Print a clean `[PASS]` / `[FAIL]` line per criterion
- Print a final `GATE: PASS` or `GATE: FAIL (N criteria failed)` summary line
- Exit with code `1` if any criterion fails, `0` if all pass

This replaces the multi-step gate verification with one tool call: `npm run pmci:gate:sports`.

---

## Implementation checklist

- [x] `docs/db-schema-reference.md` created (Decision 2) — 2026-04-10
- [x] `CLAUDE.md` updated to reference schema doc (Decision 2) — 2026-04-10
- [x] `package.json` — add `pmci:accept:sports` script (Decision 3) — 2026-04-10
- [x] `package.json` — add `pmci:gate:sports` script (Decision 6) — 2026-04-10
- [x] `scripts/gate/pmci-gate-sports.mjs` — gate verification script (Decision 6) — 2026-04-10
- [ ] Standard process pattern: DC `start_process` + log redirect (Decision 1, apply going forward)
- [ ] Agent split nuanced rule: documented above, apply at session start (Decision 4)
- [ ] Lock conflict: wait-and-retry, documented above (Decision 5)
