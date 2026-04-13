# PMCI Development Workflow

## Responsibility Model

### Claude Cowork

Claude Cowork is responsible for:
- planning
- reasoning
- orchestration
- triggering other tools
- validation

Claude Cowork must not perform large repository edits.

### OpenClaw

OpenClaw is responsible for:
- repository analysis
- repository execution
- multi-file changes
- large diffs
- commit creation
- long-running execution tasks
- code generation
- code editing and refactoring
- file and document creation
- reviewer audit

## Flow

1. Operator → Claude Cowork
2. Claude Cowork → planning
3. OpenClaw → repository execution + code generation
4. OpenClaw → reviewer audit

## Rules

- Documentation and repo context must be read before planning or implementation:
  - `docs/architecture.md`
  - `docs/system-state.md`
  - `docs/api-reference.md`
- Do not modify `lovable-ui` unless explicitly requested.
- Do not modify backend or frontend code when the task is documentation-only.
- Only proceed to the next phase if the previous phase succeeds.

## Expected Output

Each completed run should return:
- implementation summary
- files changed
- review findings
