# PMCI Development Workflow

## Responsibility Model

### Claude Computer

Claude Computer is responsible for:
- planning
- reasoning
- orchestration
- triggering other tools

Claude Computer must not perform large repository edits.

### OpenClaw

OpenClaw is responsible for:
- repository analysis
- repository execution
- multi-file changes
- large diffs
- commit creation
- long-running execution tasks
- reviewer audit

### Cursor

Cursor is responsible for:
- fast code editing
- implementing functions
- refactoring files
- polishing code changes

Cursor is an implementation accelerator, not the planner or final reviewer.

## Flow

1. Operator → Claude Computer
2. Claude Computer → planning
3. OpenClaw → repository execution
4. Cursor → code editing when needed
5. OpenClaw → reviewer audit

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
