# Fly.io deployment (PMCI API + observer)

This repo ships two Fly [Machines](https://fly.io/docs/machines/) apps that share one Docker image. The image entrypoint (`docker-entrypoint.sh`) selects the process using `PMCI_FLY_ROLE`:

| Role       | Config                         | Process          |
| ---------- | ------------------------------ | ---------------- |
| `api`      | [`deploy/fly.api.toml`](../deploy/fly.api.toml)       | `node src/api.mjs` |
| `observer` | [`deploy/fly.observer.toml`](../deploy/fly.observer.toml) | `node observer.mjs` |

Configs assume region `iad` (US East). Adjust `primary_region` in both files if you want a different region.

## Prerequisites

- [Flyctl](https://fly.io/docs/hands-on/install-flyctl/) installed. **Log in before deploy:** `fly auth login` (or `flyctl auth login`). Confirm with `fly auth whoami`.
- For **local** `docker build`, the Docker daemon must be running (e.g. start **Docker Desktop**, or `colima start` if you use Colima). If you skip local builds, use `fly deploy --remote-only` (build runs on Fly; no local Docker required).
- Globally unique app names. Replace `pmci-api` and `pmci-observer` in the TOML files (or pass `-a <name>`) if names are taken.

## End-to-end sequence (first time)

Run from the repository root, in order:

1. `fly auth login`
2. `fly apps create pmci-api` and `fly apps create pmci-observer` (ignore errors if apps already exist)
3. `fly secrets set` for each app as in [Secrets (both apps)](#secrets-both-apps)
4. Deploy (pick one build mode):
   - **Remote build (no local Docker):** use the `--remote-only` commands in [Deploy](#deploy).
   - **Local build:** run [Validate the image locally](#validate-the-image-locally), then deploy without `--remote-only`.
5. [Verify](#verify)

### Exact commands (sequential, from repo root)

Run these in order. Replace secret placeholders with your real Supabase/Postgres values. Use the same app names as in `deploy/fly.api.toml` / `deploy/fly.observer.toml` (default: `pmci-api`, `pmci-observer`).

```bash
cd /path/to/prediction-machine

# 1) Login (once per machine)
fly auth login

# 2) Create apps (once; skip if you already created them)
fly apps create pmci-api
fly apps create pmci-observer

# 3) Secrets — API app (repeat with your real connection strings / keys)
fly secrets set -a pmci-api \
  DATABASE_URL="postgresql://..." \
  SUPABASE_URL="https://YOUR_PROJECT.supabase.co" \
  SUPABASE_ANON_KEY="YOUR_KEY" \
  PG_SSL="1"

# 3b) Secrets — observer app
fly secrets set -a pmci-observer \
  DATABASE_URL="postgresql://..." \
  SUPABASE_URL="https://YOUR_PROJECT.supabase.co" \
  SUPABASE_ANON_KEY="YOUR_KEY" \
  PG_SSL="1" \
  OBSERVER_DB_DISCOVERY="1"

# 4) Deploy (remote build; no local Docker daemon required)
fly deploy --remote-only --config deploy/fly.api.toml
fly deploy --remote-only --config deploy/fly.observer.toml

# 5) Verify
curl -sS "https://pmci-api.fly.dev/v1/health/freshness" | head
fly logs -a pmci-observer
```

**Dockerfile path:** configs live under `deploy/`, so `deploy/fly.*.toml` uses `dockerfile = "../Dockerfile"` to point at the repo-root [`Dockerfile`](../Dockerfile). The build **context** is still the repository root when you run `fly deploy` from there (Fly default), so `COPY package.json` in the Dockerfile works.

### Troubleshooting: observer exits with `SUPABASE_URL and SUPABASE_ANON_KEY ... are required`

The observer reads Supabase settings from **runtime environment variables** (Fly secrets), not from a `.env` file in the image. If `fly secrets set` failed or only set some keys (common with **a space after `\`** at line end, which breaks shell continuation), the process exits immediately and deploy smoke checks fail.

- Fix: `fly secrets list -a pmci-observer` — confirm `SUPABASE_URL` and `SUPABASE_ANON_KEY` exist.
- Re-run `fly secrets set -a pmci-observer` with valid `NAME=value` pairs; avoid `\ ` (backslash + space) at end of line.
- Redeploy: `fly deploy --remote-only --config deploy/fly.observer.toml`.

## One-time app creation

**Required before the first `fly deploy`.** If deploy fails with `Error: app not found`, create the apps first (names must match `app = "..."` in each TOML).

From the repository root:

```bash
fly apps create pmci-api
fly apps create pmci-observer
```

If a name is taken globally on Fly, pick a unique name (e.g. `jaylen-pmci-api`), then update `app = "..."` in [`deploy/fly.api.toml`](../deploy/fly.api.toml) / [`deploy/fly.observer.toml`](../deploy/fly.observer.toml) to match before deploying.

## Secrets (both apps)

Set on **each** app with `fly secrets set -a <app> ...` (values are not echoed in logs; never commit them).

**Shared (API + observer):**

| Variable            | Purpose |
| ------------------- | ------- |
| `DATABASE_URL`      | Postgres (Supabase pooler connection string is typical). |
| `SUPABASE_URL`      | Supabase project URL. |
| `SUPABASE_ANON_KEY` | Or `SUPABASE_SERVICE_ROLE_KEY` if you intentionally use the service role on the server. |

**Postgres TLS from Fly to Supabase:** set `PG_SSL=1` unless your driver already gets SSL from the URL alone (see [`src/platform/db.mjs`](../src/platform/db.mjs)).

**API app only (`pmci-api`):**

| Variable               | Purpose |
| ---------------------- | ------- |
| `PMCI_API_KEY`         | If set, required as `x-pmci-api-key` on gated routes (health routes stay public). |
| `PMCI_ADMIN_KEY`       | Optional; gates `POST /v1/resolve/link`. |
| `PMCI_MAX_LAG_SECONDS` | Optional freshness SLO (default 120). |
| `PMCI_RATE_LIMIT_MAX` / `PMCI_RATE_LIMIT_WINDOW_MS` | Optional. |

**Observer app only (`pmci-observer`):**

| Variable                      | Purpose |
| ----------------------------- | ------- |
| `OBSERVER_DB_DISCOVERY`       | Set to `1` to merge DB frontier pairs each cycle (matches common local setups). |
| `OBSERVER_USE_DB_FRONTIER_ONLY` | Set to `1` to ignore static JSON and use only DB pairs (optional). |
| `SPREAD_OBSERVER_INTERVAL_SEC` | Seconds between cycles (default 60). |
| `PMCI_INGESTION_MAX_RETRIES`  | Optional PMCI write retries. |

Do **not** set `PMCI_FLY_ROLE` via secrets; it is already set in each `fly.toml` under `[env]`.

Example (repeat per app with the right secret set):

```bash
fly secrets set -a pmci-api \
  DATABASE_URL="postgresql://..." \
  SUPABASE_URL="https://....supabase.co" \
  SUPABASE_ANON_KEY="..." \
  PG_SSL="1"

fly secrets set -a pmci-observer \
  DATABASE_URL="postgresql://..." \
  SUPABASE_URL="https://....supabase.co" \
  SUPABASE_ANON_KEY="..." \
  PG_SSL="1" \
  OBSERVER_DB_DISCOVERY="1"
```

## Validate the image locally

With Docker installed:

```bash
docker build -t pmci-fly:test .
```

Optionally run a one-off shell in the image only for debugging (requires overriding the entrypoint); production uses `PMCI_FLY_ROLE` only.

## Deploy

From the repository root (where `Dockerfile` lives). **`--remote-only`** builds on Fly’s builders so you do not need a local Docker daemon (recommended if `docker build` fails with a socket error).

```bash
fly deploy --remote-only --config deploy/fly.api.toml
fly deploy --remote-only --config deploy/fly.observer.toml
```

If your Docker daemon is running and you prefer a local build, omit `--remote-only`:

```bash
fly deploy --config deploy/fly.api.toml
fly deploy --config deploy/fly.observer.toml
```

## Verify

```bash
curl -sS "https://pmci-api.fly.dev/v1/health/freshness" | head
fly logs -a pmci-observer
```

Replace `pmci-api` with your API app name. You should see observer cycle logs and PMCI ingestion messages when `DATABASE_URL` and provider rows are valid.

## Cutover from a laptop observer

When the Fly observer is healthy, stop the local process so you do not double-poll providers or duplicate work (e.g. stop `pmci-observer` in PM2 or exit the local `node observer.mjs`). Keep using a local API only for development; point production clients at the Fly URL.

## Supabase networking

If the Supabase project restricts database access by IP, allow Fly egress or use a connection path that permits Fly Machines. Connection failures from Fly but not from localhost usually indicate an IP allowlist or SSL issue.

## TLS at the edge

Fly terminates HTTPS for public apps. You do not need Caddy on the Machine for the API app; see [`docs/deployment.md`](deployment.md) for the older VPS + Caddy pattern.
