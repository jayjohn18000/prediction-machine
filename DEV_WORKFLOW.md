# PMCI Development Workflow

_Last updated: 2026-04-15_

## Responsibility Model

### Claude Cowork (primary orchestrator)

Claude Cowork is responsible for:
- planning
- reasoning
- orchestration
- triggering other tools (including Cursor GUI automation)
- validation
- single-file fixes, config edits, shell/git/API ops when they fit inside the current context budget

Claude Cowork performs repository edits directly when the task is small and context allows. When context pressure grows or the task requires careful multi-file work, Cowork delegates to Cursor (see below) rather than pushing through a bloated context window.

### Cursor (primary code executor)

Cursor is the primary execution surface for all non-trivial code changes. Cursor is driven either:

1. **By the operator directly** — paste a handoff prompt into Cursor and run it with `@Codebase` / `@Terminal`.
2. **By a Cowork sub-agent via GUI automation** — Cowork spawns a fresh, context-clean sub-agent which drives Cursor through desktop-control tools (see `cursor-orchestrator` skill). This is the preferred path when the main Cowork session's context is saturated or when the task benefits from isolation.

Cursor owns:
- repository analysis on large diffs
- multi-file changes and refactors
- schema migrations
- long-running code generation
- reviewer audit passes on large changesets

### Context-aware agent spawning

When the current Cowork conversation's context is high (rough heuristic: >60% used, or the task touches 3+ files), spin up a fresh sub-agent rather than continuing in the main session. Two patterns:

- **Cursor-driver sub-agent** — a sub-agent whose only job is to drive Cursor via GUI automation for a scoped task. Returns a summary + diff reference on completion.
- **Scoped worker sub-agent** — for research, audit, or verification work that doesn't require Cursor. Keeps the main session's context focused on orchestration.

See the `cursor-orchestrator` skill for the standard dispatch pattern.

## Flow

1. Operator → Claude Cowork
2. Cowork plans; decides executor based on task size + context budget
3. Executor (Cowork-direct, Cursor-manual, or Cursor via sub-agent) implements
4. Cowork validates, updates `docs/system-state.md`, and closes the loop

## Rules

- Documentation and repo context must be read before planning or implementation:
  - `docs/architecture.md`
  - `docs/system-state.md`
  - `docs/api-reference.md`
- Do not modify `lovable-ui` unless explicitly requested.
- Do not modify backend or frontend code when the task is documentation-only.
- Only proceed to the next phase if the previous phase succeeds.
- Prefer spawning a fresh sub-agent over continuing in a context-heavy main session.

## Expected Output

Each completed run should return:
- implementation summary
- files changed
- review findings

---

## Appendix — Deprecation history

> ⚠️ DEPRECATED — 2026-04-15
> **OpenClaw / Plumbo is no longer part of this workflow.** Prior versions of this document assigned heavy execution to OpenClaw (a local agent at `http://127.0.0.1:18789` hosting the Plumbo coding agent). That pattern has been replaced by Cursor GUI automation, driven either by the operator directly or by a Cowork sub-agent.
>
> Historical references to OpenClaw/Plumbo in `docs/openclaw-prompts/`, `.claude/commands/openclaw-dispatch.md`, and various phase plans are retained as a record of past work. Do not invoke them. See the current workflow above for how to dispatch execution today.
