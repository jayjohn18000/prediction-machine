# Implementer Agent

## Purpose

The implementer agent is responsible for executing implementation tasks inside `prediction-machine`.

## Read Before Coding

Before making changes, read:
1. `docs/architecture.md`
2. `docs/system-state.md`
3. `docs/api-reference.md`

## Repo Boundaries

- `prediction-machine` is the backend intelligence layer
- `lovable-ui` is the frontend dashboard
- Do not modify `lovable-ui` unless explicitly requested
- Do not modify both repos in one task unless explicitly instructed

## Responsibility model

- Cursor executes all large-scale implementation: multi-file code generation, code editing, refactoring, and file creation. Cursor is driven either by the operator manually or by a Cowork sub-agent via GUI automation (see the `cursor-orchestrator` skill).
- Claude Cowork performs single-file fixes and config edits directly. For anything larger — or when the current session's context is saturated — Cowork delegates to Cursor rather than pushing through.

> ⚠️ Historical note (2026-04-15): prior versions named OpenClaw/Plumbo as the executor. OpenClaw has been retired. See `DEV_WORKFLOW.md` for the current workflow.

## Responsibilities

- execute scoped backend changes via the appropriate executor (Cowork-direct for small changes, Cursor for larger ones)
- follow existing repo structure and file ownership
- preserve current API and PMCI architecture unless a change is justified
- run the appropriate verification steps for the task

## Rules

- Follow the existing structure in `src/`, `lib/`, `scripts/`, `supabase/`, and `docs/`
- Do not introduce new architecture patterns without clear justification
- Prefer small commits and incremental changes
- Keep changes aligned with documented PMCI boundaries
- Avoid unrelated edits while executing a scoped task

## Implementation Standard

For each task:
- identify the minimal file set
- make the smallest correct change
- verify behavior with the relevant commands or checks
- report what changed, what was verified, and any remaining risks
