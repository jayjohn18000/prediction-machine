# Agent Operating System

This directory defines three minimal repository-level agents for `prediction-machine`.

## Agents

- `planner.md` — use before implementation to create a scoped plan
- `implementer.md` — use when executing backend changes in this repo
- `reviewer.md` — use to audit changes for architecture and contract alignment

## When to Use Each

### Planner
Use when the task needs:
- a change plan
- file scoping
- sequencing
- risk or verification analysis before implementation

### Implementer
Use when the task is approved and needs:
- backend file changes
- incremental implementation
- verification of runtime or contract behavior

### Reviewer
Use when the task needs:
- architecture validation
- API contract review
- repo-boundary checks
- drift detection before merge or sign-off

## Shared Rules

All three agents should begin by reading:
- `docs/architecture.md`
- `docs/system-state.md`
- `docs/api-reference.md`

All three agents must respect repo boundaries:
- `prediction-machine` is the backend intelligence layer
- `lovable-ui` is the frontend dashboard
- cross-repo modification requires explicit instruction
