# Phase E2: Auto-Review Gate — Execution Plan

## Overview
Adds an autonomous proposal acceptance loop for crypto and economics categories. Instead of manual `npm run pmci:review`, a gated auto-acceptor script runs after each proposer, checks confidence + guard rules + no existing rejection, then POSTs to `/v1/review/decision`. An audit trip-wire runs immediately after to catch any semantic violations — if violations are found, the batch is flagged and halted, not silently committed.

## Prerequisites
- `npm run pmci:ingest:crypto` and `npm run pmci:ingest:economics` have run at least once (markets seeded)
- `DATABASE_URL`, `PMCI_API_KEY`, and `PMCI_ADMIN_KEY` set in `.env`
- PMCI API reachable at `https://pmci-api.fly.dev` (production on Fly.io); set `API_BASE_URL` to override for local testing
- `pmci:propose:crypto` and `pmci:propose:economics` scripts working (verified)

## Execution Steps

### Step 1: Run ingest + proposer with dry-run to baseline candidate counts
Before building the auto-acceptor, confirm there are actual proposals to work with.

```bash
npm run pmci:ingest:crypto
npm run pmci:ingest:economics
node scripts/review/pmci-propose-links-crypto.mjs --dry-run --verbose
node scripts/review/pmci-propose-links-economics.mjs --dry-run
```

**Files affected:** none (read-only)
**Expected output:** non-zero `considered` counts; `inserted` count shows candidates available

---

### Step 2: Create `scripts/review/pmci-auto-accept.mjs`
Write the auto-acceptor. Acceptance rules (all must pass):

- `confidence >= PMCI_AUTO_ACCEPT_MIN_CONFIDENCE` (env, default `0.70`)
- `decision IS NULL` (not previously rejected)
- Category is in `PMCI_AUTO_ACCEPT_CATEGORIES` (env, default `crypto,economics`)
- No existing active `market_links` row for either market ID (dedup guard)

For each passing proposal, POST to `http://localhost:${PMCI_PORT}/v1/review/decision` with `{ proposed_id, decision: "accepted" }` and header `x-pmci-api-key`. Log each acceptance with family ID, confidence, and category. Log skips with reason.

**Files affected:** `scripts/review/pmci-auto-accept.mjs` (new)
**Expected output:** script runs, prints `accepted=N skipped=N flagged=N`

---

### Step 3: Create `scripts/review/pmci-auto-accept-audit.mjs`
Post-acceptance audit trip-wire. Queries `pmci.proposed_links` where `decision='accepted'` and `created_at > now() - interval '1 hour'`, then for each accepted pair checks:

- Both market IDs still have `status IN ('active','open')` in `provider_markets`
- Relationship type is `equivalent` (no proxy links accepted automatically)
- Category on both legs matches the expected category

If any check fails: print violation, exit code 1. This gates CI and cron — acceptance only sticks if the audit passes.

**Files affected:** `scripts/review/pmci-auto-accept-audit.mjs` (new)
**Expected output:** exits 0 with `audit:pass violations=0`, or exits 1 listing violations

---

### Step 4: Add npm scripts to `package.json`

```json
"pmci:auto-accept":       "node scripts/review/pmci-auto-accept.mjs",
"pmci:auto-accept:audit": "node scripts/review/pmci-auto-accept-audit.mjs",
"pmci:review:crypto":     "npm run pmci:propose:crypto && npm run pmci:auto-accept && npm run pmci:auto-accept:audit",
"pmci:review:economics":  "npm run pmci:propose:economics && npm run pmci:auto-accept && npm run pmci:auto-accept:audit"
```

**Files affected:** `package.json`
**Expected output:** `npm run pmci:review:crypto` runs propose → accept → audit in sequence

---

### Step 5: Add `ingest-and-review-crypto` and `ingest-and-review-economics` to `admin-jobs.mjs`
These are the full pipeline jobs triggered by cron: ingest → propose → auto-accept → audit.

```js
"review-crypto":    ["node", ["scripts/review/pmci-propose-links-crypto.mjs"]],
"review-economics": ["node", ["scripts/review/pmci-propose-links-economics.mjs"]],
"auto-accept":      ["node", ["scripts/review/pmci-auto-accept.mjs"]],
```

**Files affected:** `src/routes/admin-jobs.mjs`
**Expected output:** `GET /v1/admin/jobs` lists the new job names

---

### Step 6: Add auto-accept to `pmci-job-runner/index.ts` JOB_MAP

```ts
"review:crypto":    "/v1/admin/jobs/review-crypto",
"review:economics": "/v1/admin/jobs/review-economics",
"auto-accept":      "/v1/admin/jobs/auto-accept",
```

Deploy updated edge function with `supabase functions deploy pmci-job-runner`.

**Files affected:** `supabase/functions/pmci-job-runner/index.ts`
**Expected output:** edge function v3 active

---

### Step 7: Create migration `20260416000001_pmci_auto_review_cron.sql`
Schedule propose + auto-accept as a cron pipeline (runs a few hours after ingest):

| Job | Schedule | Body |
|-----|----------|------|
| `pmci-review-crypto` | `0 8,14,20,2 * * *` | `{"job":"review:crypto"}` |
| `pmci-review-economics` | `0 6,12,18,0 * * *` | `{"job":"review:economics"}` |

Apply with `supabase db push` or via MCP `apply_migration`.

**Files affected:** `supabase/migrations/20260416000001_pmci_auto_review_cron.sql` (new)
**Expected output:** 2 new rows in `cron.job`

---

### Step 8: Verify end-to-end with dry-run gate
Run the full pipeline once with `--dry-run` on the proposer and `--audit-only` on auto-accept to confirm wiring without touching the DB.

```bash
node scripts/review/pmci-propose-links-crypto.mjs --dry-run
node scripts/review/pmci-auto-accept-audit.mjs
```

**Files affected:** none
**Expected output:** no errors, audit exits 0

---

## Verification
- `npm run pmci:review:crypto` completes without exit code 1
- `cron.job` contains `pmci-review-crypto` and `pmci-review-economics`
- `pmci.proposed_links` shows rows with `decision='accepted'` for category `crypto` or `economics`
- `pmci.market_links` grows by the accepted count
- `npm run verify:schema` still passes after acceptance

## Rollback
- Reset accepted proposals: `UPDATE pmci.proposed_links SET decision = NULL WHERE category IN ('crypto','economics') AND created_at > '<date>'`
- Delete market_links created from those proposals
- Drop the two new cron jobs: `SELECT cron.unschedule('pmci-review-crypto'); SELECT cron.unschedule('pmci-review-economics');`
