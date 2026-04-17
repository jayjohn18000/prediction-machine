# Supabase platform audit state (prediction-machine)

Machine-readable artifacts from the **Supabase platform audit** workflow (Cursor skill: `.cursor/skills/supabase-platform-audit/SKILL.md`). This complements [`state/repo-audit/`](../repo-audit/README.md) (roadmap/git/npm verification).

## Layout

| Path | Purpose |
|------|---------|
| `daily/YYYY-MM-DD.json` | Full snapshot: MCP-gathered DB/advisors/logs/migrations/edge/storage + synthesized `operationalHealth` + tiered `proposals`. |
| `daily/YYYY-MM-DD.delta.md` | Optional; written when **yesterday’s** JSON exists — fingerprint/advisor/log diff vs prior UTC day. |

Dates use **UTC** (`toISOString().slice(0, 10)`), same convention as repo audit.

## How artifacts are produced

1. Configure Supabase MCP with **`read_only=true`** and **`project_ref=awueugxrdlolzjzikero`** (see `.cursor/skills/supabase-platform-audit/reference.md`).
2. Run the agent skill **supabase-platform-audit** in Cursor (or follow the phase checklist manually).
3. Write output to `daily/YYYY-MM-DD.json` under this directory.

**No automatic schema changes** — proposals are human-reviewed only.

## Git retention

By default **`daily/*.json` is gitignored** to avoid noisy commits (see root `.gitignore`). Commit a weekly summary manually if you want history in-repo, or copy excerpts to internal docs.

## CLI helper (migration drift, no MCP)

Compare **local** `supabase/migrations/*.sql` to a **remote** list captured elsewhere (e.g. paste from MCP `list_migrations` into a JSON file):

```bash
npm run audit:supabase:migration-drift
npm run audit:supabase:migration-drift -- --remote-json /path/to/remote-migrations.json
```

See `scripts/audit/supabase-migration-drift.mjs --help`.

## Related

| Artifact | Focus |
|----------|--------|
| `state/supabase-audit/` | Supabase platform ops (this folder) |
| `state/repo-audit/` | Roadmap, git, `verify:schema`, wiki excerpts |
