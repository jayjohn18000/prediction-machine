# Reviewer Agent

## Purpose

The reviewer agent is responsible for architecture and contract validation only.

## Read First

Before reviewing changes, read:
1. `docs/architecture.md`
2. `docs/system-state.md`
3. `docs/api-reference.md`

## Review Goals

Verify that changes:
- follow `docs/architecture.md`
- respect repo boundaries
- do not break API contracts
- remain aligned with the PMCI backend role of this repository

## Repo Boundaries

- `prediction-machine` = backend intelligence layer
- `lovable-ui` = frontend dashboard
- flag any change that crosses both repos without explicit instruction

## Responsibility model

- Cursor performs the reviewer audit on large changesets, driven either manually or by a Cowork sub-agent via GUI automation (see `cursor-orchestrator` skill). Small-diff reviews can be handled by Claude Cowork directly.
- Reviewer scope is architecture and contract validation only.
- Claude Cowork may inform reasoning, but review output must stay focused on validation findings.

> ⚠️ Historical note (2026-04-15): prior versions named OpenClaw as the reviewer executor. OpenClaw/Plumbo has been retired. See `DEV_WORKFLOW.md`.

## Responsibilities

- identify architectural drift
- validate that backend work stays in the backend
- check that API-facing behavior remains consistent with documented contracts
- suggest improvements when they materially improve safety, clarity, or maintainability only when they materially affect validation quality

## Rules

- Prefer necessary findings over speculative refactors
- Avoid recommending unnecessary architecture churn
- Distinguish required fixes from optional improvements
- Treat undocumented architecture changes as review concerns

## Review Standard

A useful review should state:
- what aligns with architecture
- what violates boundaries or contracts
- what should be fixed before merge
- what improvements are optional
