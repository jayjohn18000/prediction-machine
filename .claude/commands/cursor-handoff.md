> ✅ REACTIVATED — 2026-04-15
> The 2026-04-09 deprecation is reversed. OpenClaw/Plumbo has been retired
> (see `DEV_WORKFLOW.md`), and Cursor is once again the primary code
> executor. Use this command to prepare a Cursor handoff, either for manual
> paste or for a Cowork sub-agent driving Cursor via GUI automation
> (see the `cursor-orchestrator` skill).

---

Save the current plan as a Cursor-ready prompt and output the Cursor invocation.

Working directory: /Users/jaylenjohnson/prediction-machine
Cursor prompts folder: docs/cursor-prompts/

## What this skill does

When the user says "plan for cursor", "cursor handoff", or invokes /cursor-handoff:

1. Determine a short topic slug from the current work (e.g., "matching-system-phase0", "api-latency-fix", "ingestion-bug-fix").
   - If the user passed an argument ($ARGUMENTS), use it as the topic slug.
   - Otherwise, infer from the current plan file or recent conversation context.

2. Compose the prompt content:
   - If the plan file at `.claude/plans/swift-gliding-starfish.md` has a "Cursor Implementation Prompt" section, extract that section as the content.
   - Otherwise, use the full plan file content.
   - Prepend a header with today's date and the agents line:
     ```
     # Cursor Prompt: [Descriptive title]
     > Generated: [YYYY-MM-DD]
     > Agents: @Codebase @Terminal
     ```

3. Write the composed content to:
   `docs/cursor-prompts/[YYYY-MM-DD]-[topic-slug].md`
   Use today's date. If a file with that name already exists, append `-v2`, `-v3`, etc.

4. Print the Cursor invocation block exactly as follows:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Cursor Handoff — [filename]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Open Cursor in this repo, then paste:

  @docs/cursor-prompts/[filename].md

Cursor context to attach (these are Cursor built-ins, not repo files):
  @Codebase  — Cursor's built-in: indexes your repo so Cursor can explore files before editing
  @Terminal  — Cursor's built-in: attaches terminal output so Cursor can verify commands inline

To open the file:
  cat docs/cursor-prompts/[filename].md
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

5. Ask: "Open the prompt file now for review?" — if yes, print its full contents.

## Cursor context guidance

Note: `@Codebase` and `@Terminal` are **Cursor built-in context providers**, not files or agents in this repo.
- `@Codebase` — always include; lets Cursor search files before writing code.
- `@Terminal` — include when the plan has verification steps that require running npm commands.
- The `agents/*.md` files in this repo are Claude Code role definitions for `/coordinate` — they are NOT Cursor agents and do not need to be referenced in Cursor handoffs.
- If the plan involves schema changes (migrations), add a note to read `supabase/migrations/` first.
- Do NOT add @Web unless the plan requires fetching external documentation.

## Convention for naming

| Type of work | Slug pattern |
|---|---|
| New feature or subsystem | `[system]-[phase]` e.g. `matching-system-phase0` |
| Bug fix | `fix-[description]` e.g. `fix-ingestion-collision` |
| Performance | `perf-[endpoint]` e.g. `perf-market-families` |
| Schema change | `schema-[description]` e.g. `schema-add-features-column` |
| Refactor | `refactor-[module]` e.g. `refactor-proposer` |
