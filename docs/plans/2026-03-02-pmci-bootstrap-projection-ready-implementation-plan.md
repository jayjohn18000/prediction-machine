# PMCI Bootstrap + Projection-Ready Endpoint Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a PMCI bootstrap CLI and a `/v1/health/projection-ready` API endpoint that share consistent readiness criteria and a configurable freshness threshold, so operators can quickly verify projection readiness from both CLI and HTTP.

**Architecture:** A standalone Node.js CLI script (`scripts/pmci-bootstrap.mjs`) will use a direct `pg.Client` connection and existing PMCI helpers to run a sequence of DB checks, while the Fastify API (`src/api.mjs`) will expose an aggregated readiness endpoint powered by a single SQL query and the existing connection pool. Both surfaces will treat snapshot freshness using the same env-configurable threshold, reusing `PMCI_MAX_LAG_SECONDS` semantics.

**Tech Stack:** Node.js ES modules, `pg` client, Fastify, Zod, Supabase Postgres (PMCI schema).

---

### Task 1: Scaffold pmci-bootstrap.mjs with env loading

**Files:**
- Create: `scripts/pmci-bootstrap.mjs`

**Step 1: Implement loadEnv using existing pattern**

Implement a `loadEnv()` function in `scripts/pmci-bootstrap.mjs` by copying the pattern from `scripts/seed-pmci-families-links.mjs`:
- Use `fs.readFileSync` on `.env` in `process.cwd()`.
- Split on newlines, regex-match `KEY=VALUE` pairs, trim, and strip surrounding quotes.
- Swallow errors if `.env` is missing.

**Step 2: Wire MAX_LAG_SECONDS constant for CLI**

Define a `MAX_LAG_SECONDS` constant in `scripts/pmci-bootstrap.mjs`:
- `const MAX_LAG_SECONDS = Number(process.env.PMCI_MAX_LAG_SECONDS ?? "180");`
- This ensures the CLI respects `PMCI_MAX_LAG_SECONDS` if set but defaults to 180 seconds.

**Step 3: Add shebang and main wrapper**

Add the Node shebang and a basic `main()` function:
- Shebang: `#!/usr/bin/env node`
- Call `loadEnv()` at module top.
- Define `async function main() { /* logic will be filled in later tasks */ }`
- At bottom, invoke `main().catch(...)` to log errors and `process.exit(1)` on unexpected failures.

---

### Task 2: Implement env check and DB connection in pmci-bootstrap.mjs

**Files:**
- Modify: `scripts/pmci-bootstrap.mjs`

**Step 1: Add DATABASE_URL presence check**

Inside `main()`, after `loadEnv()` has run:
- Read `const databaseUrl = process.env.DATABASE_URL?.trim();`
- If missing or empty:
  - `console.error` the exact multi-line message from the spec about PMCI requiring direct Postgres and how to obtain the connection string.
  - Call `process.exit(1);`

**Step 2: Create and connect pg.Client**

Import `pg` and destructure `Client`:
- `import pg from "pg"; const { Client } = pg;`

In `main()`:
- Instantiate `const client = new Client({ connectionString: databaseUrl });`
- Wrap `await client.connect()` in `try/catch`.
- On connection failure:
  - Log a clear message including `err.message`.
  - Attempt `await client.end()` if client exists.
  - `process.exit(1);`

**Step 3: Ensure client is ended on success paths**

Structure `main()` as:
- `const client = new Client(...);`
- `await client.connect();`
- `try { /* checks in later tasks */ } finally { await client.end(); }`
- Keep early-failure branches (like missing `DATABASE_URL`) before creating the client.

---

### Task 3: Implement provider ID check using getProviderIds

**Files:**
- Modify: `scripts/pmci-bootstrap.mjs`

**Step 1: Import getProviderIds from pmci-ingestion**

At top of `scripts/pmci-bootstrap.mjs`:
- `import { getProviderIds } from "../lib/pmci-ingestion.mjs";`

**Step 2: Call getProviderIds after successful connect**

Within the `try` block that runs after `client.connect()`:
- Call `const providerIds = await getProviderIds(client);`
- If `providerIds == null`:
  - Print the exact error string from the spec:
    - `"ERROR: pmci.providers missing 'kalshi' or 'polymarket'. Run migrations: npx supabase db push"`
  - Ensure `await client.end();` is called (either by exiting after the try/finally or explicitly before exit).
  - `process.exit(1);`

---

### Task 4: Implement provider_markets and snapshots checks in pmci-bootstrap.mjs

**Files:**
- Modify: `scripts/pmci-bootstrap.mjs`

**Step 1: Query and validate provider_markets count**

Using the connected `client`:
- Run `SELECT COUNT(*)::bigint AS count FROM pmci.provider_markets;`
- Parse the result as a number.
- If `count === 0`:
  - Print the multi-line error from the spec:
    - `"ERROR: No provider_markets found. The observer has not run yet.\nFix: Set DATABASE_URL and run: npm run start\nWait for at least 1 full cycle (log: 'PMCI ingestion: markets_upserted=...')"`
  - Ensure `await client.end();` and then `process.exit(1);`
- Else:
  - `console.log(\`✓ provider_markets: ${count}\`);`

**Step 2: Query and log provider_market_snapshots count**

Run `SELECT COUNT(*)::bigint AS count FROM pmci.provider_market_snapshots;`
- Parse as number.
- If `count === 0`:
  - Print WARN message (exact from spec) about no snapshots and observer possibly still on first cycle.
- Else:
  - `console.log(\`✓ provider_market_snapshots: ${count}\`);`
- Persist the snapshots count in a local variable for final summary.

---

### Task 5: Implement families, active links, and freshness checks in pmci-bootstrap.mjs

**Files:**
- Modify: `scripts/pmci-bootstrap.mjs`

**Step 1: Query and log market_families count**

Run `SELECT COUNT(*)::bigint AS count FROM pmci.market_families;`
- Parse as number.
- If `count === 0`:
  - Print WARN message from spec about running `npm run seed:pmci` and what families represent.
- Else:
  - `console.log(\`✓ market_families: ${count}\`);`
- Store `familiesCount` for both Step 7 logic and final summary.

**Step 2: Query and log active links count**

Run `SELECT COUNT(*)::bigint AS count FROM pmci.v_market_links_current;`
- Parse as number.
- If `count === 0 && familiesCount > 0`:
  - Print WARN message about families existing but no active links, advising to check migrations.
- Else if `count > 0`:
  - `console.log(\`✓ active links: ${count}\`);`
- Store `linksCount` for final summary.

**Step 3: Implement freshness check using MAX_LAG_SECONDS**

Run:
- `SELECT EXTRACT(EPOCH FROM (now() - MAX(observed_at)))::int AS lag_seconds FROM pmci.provider_market_snapshots;`
- Parse `lag_seconds` as a number (handle null as needed).
- If `lag_seconds > MAX_LAG_SECONDS`:
  - Print WARN message:
    - `"WARN: Last snapshot is {lag_seconds}s ago. Observer may not be running.\n       Run: npm run start"`
- Else:
  - `console.log(\`✓ snapshot freshness: ${lagSeconds}s ago\`);`
- Also persist `snapshotsCount` (from Task 4), `familiesCount`, and `linksCount` so the final summary can include them.

---

### Task 6: Implement final summary and hook pmci-bootstrap into package.json

**Files:**
- Modify: `scripts/pmci-bootstrap.mjs`
- Modify: `package.json`

**Step 1: Print final ready summary in CLI**

After all checks run successfully (no `exit(1)` from earlier tasks):
- Print exactly:
  - `"\n✓ Projection pipeline is ready.\n  Families: {familiesCount}, Links: {linksCount}, Snapshots: {snapshotsCount}\n  Start API: npm run api:pmci"`
- Ensure this only runs if `provider_markets > 0` and the provider ID check passed; WARNs from later checks should not prevent this summary.

**Step 2: Ensure client.end() is always called before exiting**

Confirm `await client.end();` is executed in a `finally` block around the main check sequence.
- Avoid calling `process.exit()` inside the `finally`; instead, early-return or exit only where necessary with prior `client.end()` calls.

**Step 3: Add npm script**

In `package.json` under `"scripts"`:
- Add `"bootstrap": "node scripts/pmci-bootstrap.mjs"` alongside other PMCI commands.

---

### Task 7: Implement /v1/health/projection-ready endpoint SQL and wiring

**Files:**
- Modify: `src/api.mjs`

**Step 1: Add new Fastify route after /v1/health/slo**

In `src/api.mjs`, immediately after the existing `/v1/health/slo` route:
- Add `app.get("/v1/health/projection-ready", async () => { /* implementation */ });`
- Reuse the existing `query` import from `./db.mjs` and `MAX_LAG_SECONDS` constant defined at the top.

**Step 2: Implement single aggregated SQL query**

Inside the route handler:
- Execute one SQL statement:
  - `SELECT (SELECT COUNT(*)::bigint FROM pmci.provider_markets) AS provider_markets, (SELECT COUNT(*)::bigint FROM pmci.provider_market_snapshots) AS snapshots, (SELECT COUNT(*)::bigint FROM pmci.market_families) AS families, (SELECT COUNT(*)::bigint FROM pmci.v_market_links_current) AS active_links, EXTRACT(EPOCH FROM (now() - (SELECT MAX(observed_at) FROM pmci.provider_market_snapshots)))::int AS lag_seconds;`
- Extract the single row and coerce each value to a number, handling nulls as 0 for counts and `null` for `lag_seconds` when no snapshots exist.

---

### Task 8: Implement readiness logic and response shape for /v1/health/projection-ready

**Files:**
- Modify: `src/api.mjs`

**Step 1: Compute per-check pass/fail booleans**

From the aggregated row:
- `providerMarketsPass = provider_markets > 0`
- `snapshotsPass = snapshots > 0`
- `familiesPass = families > 0`
- `activeLinksPass = active_links > 0`
- `lagPass = typeof lag_seconds === "number" && lag_seconds <= MAX_LAG_SECONDS`

**Step 2: Build checks object**

Return a JSON object:
- `ready`: boolean, `true` only if all five checks pass.
- `checks`: shaped as:
  - `provider_markets: { count, pass }`
  - `snapshots: { count, pass }`
  - `families: { count, pass }`
  - `active_links: { count, pass }`
  - `freshness_seconds: { lag: lag_seconds, pass }`

**Step 3: Build missing_steps array**

Initialize `missing_steps` as an empty array and push specific messages:
- If `provider_markets === 0`: `"Run observer: npm run start (wait 1 cycle)"`
- If `snapshots === 0`: `"Observer running but no snapshots yet, wait for next cycle"`
- If `families === 0`: `"Seed families: npm run seed:pmci"`
- If `active_links === 0`: `"No active links in v_market_links_current, check migrations"`
- If `lag_seconds` is a number and `lag_seconds > MAX_LAG_SECONDS`: `"Snapshots stale ({lag_seconds}s), restart observer: npm run start"`

Return `{ ready, checks, missing_steps }` on success.

---

### Task 9: Implement DB error handling for /v1/health/projection-ready

**Files:**
- Modify: `src/api.mjs`

**Step 1: Wrap DB logic in try/catch**

In the `/v1/health/projection-ready` handler:
- Wrap the SQL call and readiness computations in a `try/catch`.

**Step 2: Return HTTP 503 on DB error**

Inside `catch (err)`:
- Set response status to 503 if needed (Fastify allows `reply.code(503)` when using `(req, reply)` signature; or return a simple object while Fastify infers).
- Return:
  - `{ ready: false, error: "db_error", message: err.message, missing_steps: ["Check DATABASE_URL and DB connectivity"] }`

---

### Task 10: Manual verification steps

**Files:**
- No file changes; run commands only.

**Step 1: Verify CLI behavior**

Run in the project root:
- `node scripts/pmci-bootstrap.mjs`

Check:
- When `DATABASE_URL` is missing, it exits 1 with the specified error message.
- When DB is reachable and PMCI schema is populated:
  - Prints check outputs for provider_markets, snapshots, families, active links, and freshness.
  - If no hard failures, prints the final “Projection pipeline is ready” summary with counts.

**Step 2: Verify API endpoint behavior**

Start the API:
- `npm run api:pmci`

Then call:
- `curl http://localhost:8787/v1/health/projection-ready`

Confirm:
- Response is valid JSON with `ready` boolean, `checks` object with the five keys, and `missing_steps` array.
- Adjust `PMCI_MAX_LAG_SECONDS` in env and restart API / rerun CLI to verify both surfaces react consistently to threshold changes.

