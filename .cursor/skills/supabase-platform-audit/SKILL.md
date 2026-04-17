---
name: supabase-platform-audit
description: >-
  Read-only Supabase platform audit via MCP: database inventory, advisors, logs,
  migration drift vs repo, edge functions, storage; append JSON under
  state/supabase-audit/daily/. Tiered proposals (human approval only). Use with
  project_ref + read_only MCP URL; see reference.md.
---

# Supabase platform audit (MCP, read-only)

## When to use

- Operational health snapshot: logs, advisors, connection pressure, migration posture.
- Schema / hygiene signals: RLS flags, large tables, extension inventory — **proposals only**, never auto-apply.
- After incidents, before releases, or on a schedule (manual or agent-invoked).

**Not for:** product roadmap status — use [repo-roadmap-audit](../repo-roadmap-audit/SKILL.md) and [`state/repo-audit/`](../../../state/repo-audit/README.md).

## Preconditions

1. **MCP configured** with `project_ref=awueugxrdlolzjzikero` and **`read_only=true`**. Optional `features=` allowlist: see [`reference.md`](reference.md).
2. **Authenticated** Supabase MCP (OAuth in Cursor or PAT in supported clients).
3. **Policy:** Do **not** call `apply_migration`, `deploy_edge_function`, or other [forbidden tools](reference.md#forbidden-tools-policy).

## Orchestration: phase order

Run phases **in order**; merge into one JSON artifact. Parallelism is allowed **across independent read calls** (e.g. `get_advisors` while preparing SQL), but **merge** must be deterministic.

| Phase | Actions | MCP / local |
|-------|---------|-------------|
| **1 — Meta** | Record UTC timestamp, `schemaVersion: 1`, `projectRef`, `mcpMode: read_only` | Local |
| **2 — Fingerprints** | Capture cheap signals for next-run skipping (see below) | Derived |
| **3 — Database inventory** | `list_tables`, `list_extensions` | MCP |
| **4 — Batched SQL** | One or few `execute_sql` calls: largest relations, `pg_stat_activity` aggregates, RLS scan for `public` + `pmci`, optional `pg_stat_statements` if extension exists | MCP |
| **5 — Advisors** | `get_advisors` (security + performance) | MCP |
| **6 — Logs** | `get_logs` per service (short window, line cap); see [`reference.md`](reference.md#get_logs-services) | MCP |
| **7 — Migrations** | `list_migrations` + compare to [`supabase/migrations/`](../../../supabase/migrations/) | MCP + local list (or `npm run audit:supabase:migration-drift`) |
| **8 — Edge functions** | `list_edge_functions`; `get_edge_function` only for **metadata** or **truncated** excerpt | MCP |
| **9 — Storage** | `list_storage_buckets` if Storage feature enabled; else `skipped: true` | MCP |
| **10 — Development info** | Optionally `get_project_url`; keys only with **redaction** (see reference) | MCP |
| **11 — Docs** | `search_docs` for interpreting advisor types or Postgres behavior (P3) | MCP |
| **12 — Synthesize** | Build `operationalHealth` + tiered `proposals` | Local |
| **13 — Write** | Append `state/supabase-audit/daily/YYYY-MM-DD.json` (UTC date) | Local file write |

If any phase fails, set `meta.warnings[]` and continue when safe; partial JSON is better than silent omission.

## Output path and idempotency

- **Path:** `state/supabase-audit/daily/YYYY-MM-DD.json` where the date is **UTC** (`toISOString().slice(0, 10)`).
- **Append history:** One file per calendar day; if multiple runs the same day, either **overwrite that day’s file** with the latest full snapshot **or** use `generatedAt` inside the file and keep the last run only — prefer **one file per day** with the **latest** `generatedAt` unless you add run ids (v1: single daily snapshot is enough).
- **Optional delta:** `state/supabase-audit/daily/YYYY-MM-DD.delta.md` comparing to **yesterday’s** JSON (fingerprints, advisor counts, log error spikes).

## JSON schema (v1)

Use `schemaVersion: 1` at the root.

```json
{
  "schemaVersion": 1,
  "meta": {
    "generatedAt": "ISO-8601",
    "projectRef": "awueugxrdlolzjzikero",
    "mcpMode": "read_only",
    "warnings": []
  },
  "fingerprints": {
    "migrationCount": 0,
    "latestMigrationName": null,
    "tableCount": 0,
    "extensionNamesHash": "short-hash-or-truncated",
    "advisorSecurityCount": 0,
    "advisorPerformanceCount": 0
  },
  "database": {
    "tables": {},
    "extensions": {},
    "sql": {
      "largestRelations": [],
      "connectionSummary": [],
      "rlsSummary": [],
      "pgStatStatements": null
    }
  },
  "advisors": {},
  "logs": {
    "services": {},
    "summary": { "errorLineCountApprox": 0 }
  },
  "migrations": {
    "remote": [],
    "local": [],
    "onlyRemote": [],
    "onlyLocal": [],
    "orderedMatch": false
  },
  "edgeFunctions": { "list": [] },
  "storage": { "buckets": [], "skipped": false },
  "operationalHealth": {
    "status": "green|yellow|red",
    "topIncidents": []
  },
  "proposals": [
    {
      "id": "string-stable-id",
      "tier": "P0|P1|P2|P3",
      "title": "",
      "reason": "",
      "evidence": "",
      "risk": "",
      "requiresHumanApproval": true
    }
  ]
}
```

Fill `database.tables` / `extensions` from MCP list tools (structure can mirror MCP responses). Keep stored JSON **small**; truncate large arrays if needed.

## Tier enum (fixed)

| Tier | Meaning |
|------|---------|
| **P0** | Security / exposure (advisor security, missing RLS on exposed schemas, risky grants) |
| **P1** | Reliability / performance (slow queries, missing indexes, log error spikes, connection pressure) |
| **P2** | Hygiene (unused objects, stale rows, naming drift) — **proposal only** |
| **P3** | Informational (doc pointers, version notes) |

Every proposal **must** include `requiresHumanApproval: true` and a **risk** string. **Never** implement cleanup automatically.

## Fingerprints and fast reruns

Store in `fingerprints`:

- Remote migration **count** and **latest** name (lex order).
- **Table count** (from `list_tables` length or `COUNT` from `information_schema`).
- **Hash** of sorted extension names (simple string join + length is fine for diffing).
- Advisor **counts** by type if available.

**Optional fast path:** If env `SUPABASE_AUDIT_FORCE_FULL=1` is unset/false and yesterday’s fingerprint matches **and** the operator asks for a **pulse** run, skip heavy SQL (largest relations / full RLS list) and only refresh **advisors + logs**. Document the skip in `meta.warnings`.

## Batching rules

1. **SQL:** Prefer **one** `execute_sql` with multiple statements only if the MCP allows; otherwise **minimal** round trips (e.g. largest relations + connections in two calls).
2. **Logs:** Per-service caps (e.g. 100–300 lines total across services); short time window (e.g. 15–60 minutes).
3. **Edge:** Prefer `list_edge_functions` only; avoid pulling every function body.

## Proposal synthesis (examples)

Map **advisor security** → P0/P1; **advisor performance** → P1; **RLS disabled** on tables in exposed schemas → P0 with evidence from `database.sql.rlsSummary`; **large seq scans** → P1 with doc link via `search_docs` (P3 support).

## Related commands

| Command | Role |
|---------|------|
| `npm run audit:supabase:migration-drift` | Local migration list + optional compare to remote JSON |
| `npm run audit:repo:daily` | Repo/roadmap audit (complementary) |

## Files

- [`reference.md`](reference.md) — MCP URL, tool matrix, SQL snippets, redaction.
- [`../../../state/supabase-audit/README.md`](../../../state/supabase-audit/README.md) — artifact layout and scheduling notes.
