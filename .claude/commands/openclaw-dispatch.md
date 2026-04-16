> ⚠️ DEPRECATED — 2026-04-15
> OpenClaw / Plumbo is no longer part of this workflow. Use `/cursor-handoff`
> instead, or have Claude Cowork spawn a sub-agent that drives Cursor via
> GUI automation (see the `cursor-orchestrator` skill). This file is retained
> as a historical reference only. Do not invoke it.
>
> Current workflow: `DEV_WORKFLOW.md` at the repo root.

---

Save the current plan and dispatch it to OpenClaw for execution.

Working directory: /Users/jaylenjohnson/prediction-machine
OpenClaw prompts folder: docs/openclaw-prompts/

## What this skill does

When the user says "dispatch to openclaw", "openclaw handoff", "send to plumbo", or invokes /openclaw-dispatch:

1. Determine a short topic slug from the current work (e.g., "matching-system-phase0", "api-latency-fix", "ingestion-bug-fix").
   - If the user passed an argument ($ARGUMENTS), use it as the topic slug.
   - Otherwise, infer from the current plan file or recent conversation context.

2. Compose the dispatch content:
   - If the plan file at `.claude/plans/` has an "OpenClaw Implementation Prompt" section, extract that section as the content.
   - Otherwise, use the full plan file content.
   - Prepend a header with today's date:
     ```
     # OpenClaw Dispatch: [Descriptive title]
     > Generated: [YYYY-MM-DD]
     > Executor: OpenClaw (Plumbo)
     > Orchestrator: Claude Cowork
     ```

3. Write the composed content to:
   `docs/openclaw-prompts/[YYYY-MM-DD]-[topic-slug].md`
   Use today's date. If a file with that name already exists, append `-v2`, `-v3`, etc.

4. Use the OpenClaw skill to send the plan directly to OpenClaw for execution.

5. After dispatching, confirm with the user:
   - What was sent
   - Which file was saved to `docs/openclaw-prompts/`
   - Any verification steps OpenClaw should run and report back

## OpenClaw execution guidance

- OpenClaw (Plumbo) is the sole executor for all code changes, file edits, refactors, and commits.
- Claude Cowork handles orchestration, planning, and validation only.
- After OpenClaw completes, bring its output back to Claude Cowork for validation before marking the task done.

## Convention for naming

| Type of work | Slug pattern |
|---|---|
| New feature or subsystem | `[system]-[phase]` e.g. `matching-system-phase0` |
| Bug fix | `fix-[description]` e.g. `fix-ingestion-collision` |
| Performance | `perf-[endpoint]` e.g. `perf-market-families` |
| Schema change | `schema-[description]` e.g. `schema-add-features-column` |
| Refactor | `refactor-[module]` e.g. `refactor-proposer` |
