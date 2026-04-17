# Supabase platform audit — reference

Companion to [`SKILL.md`](SKILL.md). MCP tool names and parameters follow [Supabase MCP](https://supabase.com/docs/guides/getting-started/mcp); verify with current docs if something fails.

## Project

| Field | Value |
|--------|--------|
| **Project ref** | `awueugxrdlolzjzikero` |
| **Region** | `us-east-1` (dashboard) |

## MCP URL (least privilege)

Use the hosted MCP server with **project scope** + **read-only SQL**:

```
https://mcp.supabase.com/mcp?project_ref=awueugxrdlolzjzikero&read_only=true
```

### Optional: feature allowlist

Restrict tool groups with `features=` (comma-separated). For this audit, prefer **excluding** branching and account management unless you truly need them:

**Suggested read-only audit URL:**

```
https://mcp.supabase.com/mcp?project_ref=awueugxrdlolzjzikero&read_only=true&features=database,debugging,development,docs,edge_functions,storage
```

**Typical feature groups (names from Supabase docs):**

| Group | Tools used by this audit |
|--------|---------------------------|
| `database` | `list_tables`, `list_extensions`, `list_migrations`, `execute_sql` |
| `debugging` | `get_logs`, `get_advisors` |
| `development` | `get_project_url`, `get_publishable_keys`, `generate_typescript_types` (optional) |
| `docs` | `search_docs` |
| `edge_functions` | `list_edge_functions`, `get_edge_function` |
| `storage` | `list_storage_buckets` (and config tools if enabled — use read-only policy below) |

**Excluded on purpose (usually):**

| Group | Why |
|--------|-----|
| `branching` | Experimental; not needed for ops snapshot |
| `account_management` | Broad org/project control; avoid accidental cost/pause |

If Storage is disabled in the MCP UI, omit `storage` from `features` and note `storage.skipped: true` in the audit JSON.

### Forbidden tools (policy)

Never invoke these from this workflow, even if the client lists them:

| Tool | Reason |
|------|--------|
| `apply_migration` | Writes schema; human-driven migrations only |
| `deploy_edge_function` | Deploy is out of scope for audit |
| `create_project` / `pause_project` / `restore_project` | Org/project lifecycle |
| `create_branch` / `merge_branch` / `delete_branch` / … | Branching |
| `update_storage_config` | Mutates storage settings |

`execute_sql` must only run **SELECT** / catalog queries agreed in [`SKILL.md`](SKILL.md). No `DELETE`, `TRUNCATE`, `DROP`, `ALTER`, etc.

## Redaction rules (artifacts)

When writing `state/supabase-audit/daily/*.json` or chat output:

- **Do not** persist full **service role** or **anon** keys. If `get_publishable_keys` returns keys, replace payload with `present: true` and `redacted: true`, or store last 4 chars only.
- **Do not** paste long JWTs or PATs into JSON.
- **Truncate** `get_edge_function` source to a **small excerpt** (e.g. first 2k chars) if included at all; prefer metadata-only.
- **Truncate** log lines that look like tokens or contain `Bearer `.

## Tool × surface matrix

| Surface | MCP tools | Notes |
|---------|-----------|--------|
| Schema / tables | `list_tables`, `execute_sql` | Prefer batched aggregates; avoid `SELECT *` on wide tables |
| Extensions | `list_extensions` | Compare to expectations (e.g. `pg_cron`, `vector`) |
| Advisors | `get_advisors` | Security + performance; map to P0–P3 tiers in skill |
| Logs | `get_logs` | Services: see below |
| Migrations (remote) | `list_migrations` | Compare to repo — see **Migration drift** |
| Edge functions | `list_edge_functions`, `get_edge_function` | No deploy |
| Storage | `list_storage_buckets` | Inventory; no config mutation |
| Docs | `search_docs` | Interpret advisor flags / Postgres behavior |

## `get_logs` services

Use short windows and cap total lines in the artifact. Service identifiers follow Supabase MCP (confirm in your client if a name fails):

| Service | Use for |
|---------|---------|
| `api` | REST/Auth gateway errors, 5xx |
| `postgres` | DB errors, connection issues |
| `auth` | Auth provider / GoTrue issues |
| `edge-function` | Edge Function runtime errors |
| `realtime` | Realtime service errors |
| `storage` | Storage API errors |

Call **each** relevant service separately; merge summaries in `logs.summary` in the JSON.

## Migration drift (remote vs repo)

1. **Remote:** `list_migrations` (MCP) — collect ordered names/versions as returned.
2. **Local:** Filenames under [`supabase/migrations/`](../../../supabase/migrations/) (`*.sql`), sorted lexicographically (timestamp prefixes preserve order).
3. **Compare:** Normalize names (trim; ensure `.sql` suffix on local side).
4. **Emit:** `onlyRemote`, `onlyLocal`, `orderedMatch` (boolean if sequences align pairwise after stripping gaps), `note` if MCP returned extra metadata.

**CLI helper (no MCP):** `npm run audit:supabase:migration-drift` — local list + optional `--remote-json` for a pasted MCP snapshot.

## SQL snippets (read-only)

Run via `execute_sql` only as documented in [`SKILL.md`](SKILL.md). Guard `pg_stat_statements` behind an extension check:

```sql
SELECT extname FROM pg_extension WHERE extname = 'pg_stat_statements';
```

Connection snapshot (aggregate only):

```sql
SELECT state, COUNT(*) AS n
FROM pg_stat_activity
WHERE datname = current_database()
GROUP BY state
ORDER BY n DESC;
```

Largest relations (example):

```sql
SELECT n.nspname AS schema,
       c.relname AS relation,
       c.relkind AS kind,
       pg_total_relation_size(c.oid) AS total_bytes
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%'
ORDER BY pg_total_relation_size(c.oid) DESC
LIMIT 30;
```

RLS flag scan (may be large on huge DBs — use `LIMIT` if needed):

```sql
SELECT n.nspname AS schema,
       c.relname AS table_name,
       c.relrowsecurity AS rls_enabled,
       c.relforcerowsecurity AS rls_forced
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r'
  AND n.nspname IN ('public', 'pmci')
ORDER BY n.nspname, c.relname;
```

## Production caution

Supabase documents MCP for **development** workflows. If you point at production:

- Keep **`read_only=true`**.
- Prefer **aggregates** over dumping row data.
- Keep **Cursor tool approval** enabled and review each call.

## Verification checklist (after a run)

- [ ] No forbidden tools were invoked.
- [ ] Keys and secrets redacted in `state/supabase-audit/daily/*.json`.
- [ ] `meta.warnings` lists any skipped phase (e.g. Storage feature off, log timeout).
- [ ] `proposals` every item has `requiresHumanApproval: true` and a **risk** field.
