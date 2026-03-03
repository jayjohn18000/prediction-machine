# PMCI End-to-End Divergence Loop — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reliable end-to-end loop: ingest → seed graph → compute divergence/consensus → expose via API → validate with backtest/debug exports. Output: ranked list of best divergence windows per event with explainable reasons. No execution/trading, no new providers, no UI.

**Architecture:** Option A in place: PMCI schema in same Supabase Postgres; observer writes `pmci.provider_markets` + `pmci.provider_market_snapshots`; seeder creates `pmci.canonical_events` (by polymarketSlug) and ties `pmci.market_families.canonical_event_id`; API serves market-families, market-links, signals/divergence by event_id (UUID) and family_id. This plan sequences agent runs to verify and harden that vertical slice, then add a top-divergences report/endpoint.

**Tech Stack:** Node (observer, scripts), Supabase/Postgres (pmci schema), Fastify API in `src/api.mjs`, existing agents in `agents/`.

---

## Agent run sequence (orchestrated)

| Order | Agent | Input context (exact) | Required artifact |
|-------|--------|------------------------|--------------------|
| 1 | **INGESTION_AUDITOR** | Goal: confirm observer writes to PMCI and DEM+GOP coverage is complete. Paths: `event_pairs.json`, `scripts/prediction_market_event_pairs.json`, `observer.mjs`, `lib/pmci-ingestion.mjs`, `.env.example`, `supabase/migrations/*pmci*.sql`. Commands/logs: see “First agent prompt” below. | **Ingestion sanity checklist** + concrete fixes (if any). PR plan only if code/config changes needed. |
| 2 | **RELATIONSHIP_MANAGER** | Goal: schema/API alignment for canonical event → families → links → divergence. Modules: observer, seed script, `src/api.mjs`, migrations, `run-queries.mjs`. Focus: canonical_events UUID flow (seeder prints slug=>uuid, API expects uuid), families use canonical_event_id, labels stable (event_id::candidate), market_links / v_market_links_current used consistently. | **Dependency/alignment checklist** (dependency map + schema/API alignment). Quick fixes only if misalignment found. |
| 3 | **VALIDATION_AGENT** | Goal: acceptance test suite for the vertical slice. Commands: (1) run observer 1 cycle with DATABASE_URL set, (2) `npm run pmci:smoke` (must pass), (3) `npm run seed:pmci` (must create families/links and print slug=>uuid), (4) call APIs with printed UUID and returned family_id. Assertions: provider_markets > 0, snapshots > 0, families for event uuid > 0, links for a family >= 2, signals/divergence returns list or explicit “need more snapshots” reason. Paths: `pmci_backtest.json`, `backtest_debug.csv`, scripts, API. | **Test plan** (acceptance tests + pass/fail criteria) + **SQL spot checks** + **failure reason taxonomy**. |
| 4 | **REPORTER** | Goal: “Top Divergences” report or endpoint. Options: (A) `GET /v1/signals/top-divergences?event_id=<uuid>&limit=20`, or (B) script `scripts/report-top-divergences.mjs`. Use: family consensus price, per-link divergence vs consensus, reasons (relationship_type, confidence, last snapshot timestamp, liquidity proxy). | **Report spec** (output shape, schema, when produced) + **endpoint shape** (if API) or script contract + **sorting formula** + sanity checklist. |
| 5 | **WINDOW_SURGEON** + **CALIBRATION_ENGINEER** | Run only after steps 1–4 are stable. Goal: reduce degenerate windows at generation time; execution scoring per-event cohorts; fallback scoring for insufficient_history. Paths: `backtest-routing.mjs`, migrations (window-related), `pmci_backtest.json`. | **PR plan** + migration (if needed) + rerun evidence. |

---

## Definition of done (this iteration)

- [ ] Run observer with DATABASE_URL → PMCI ingestion active (log: `PMCI ingestion: markets_upserted=… snapshots_appended=…` or equivalent).
- [ ] `npm run pmci:smoke` **PASS** (provider_markets > 0).
- [ ] `npm run seed:pmci` creates canonical_events + families + links and **prints** `slug => uuid` lines.
- [ ] `GET /v1/market-families?event_id=<printed_uuid>` returns > 0 families.
- [ ] `GET /v1/market-links?family_id=<id>` returns ≥ 2 links.
- [ ] `GET /v1/signals/divergence?family_id=<id>` returns divergence rows or explicit “need more snapshots” message.
- [ ] Top-divergence report/endpoint **spec** ready (implementation can follow in next iteration).

---

## Merge rule

After each agent run, merge that agent’s artifact into this document (append under a “Artifacts” section or update the relevant subsection). Then either trigger the next agent with the exact input context above or mark “Plan ready for Cursor” when all steps 1–4 are done and step 5 is deferred.

---

## First agent prompt (run next): INGESTION_AUDITOR

Copy the block below into a new chat and run as the INGESTION_AUDITOR. When done, bring the output artifact back and merge it into this plan.

```markdown
You are running as **INGESTION_AUDITOR** in the Prediction Machine repo. The Coordinator has requested an ingestion sanity check for the PMCI vertical slice.

**Goal:** Confirm that the observer is actually writing to PMCI and that DEM + GOP coverage is complete. Produce an **ingestion sanity checklist** and any **concrete fixes** (if something is wrong). Do not change window logic, calibration, or execution.

**What to verify**

1. **DATABASE_URL in observer runtime**
   - Observer uses `lib/pmci-ingestion.mjs` → `createPmciClient()` which reads `process.env.DATABASE_URL`.
   - Observer loads `.env` via `loadEnv()` at startup (from repo root).
   - Confirm: when the observer runs, DATABASE_URL must be set (e.g. in `.env`) so that `createPmciClient()` returns a client; otherwise PMCI ingestion is disabled.
   - Check: observer startup logs either "PMCI ingestion enabled (DATABASE_URL set, provider IDs resolved by code)." or "PMCI ingestion disabled: ...".

2. **PMCI tables growing**
   - Observer upserts `pmci.provider_markets` and appends `pmci.provider_market_snapshots` per configured pair (via `ingestPair()`). Each cycle logs: `PMCI ingestion: markets_upserted=<N> snapshots_appended=<M>` when N or M > 0.
   - Commands to inspect:
     - Run observer for 1–2 cycles: `npm run start` (with DATABASE_URL in `.env`). Capture startup line and at least one cycle line containing "PMCI ingestion: markets_upserted=… snapshots_appended=…".
     - Then run: `npm run pmci:smoke`. It must report provider_markets > 0 and snapshots > 0 (smoke exits non-zero if provider_markets == 0).
   - If observer uses a different event-pairs file (e.g. `SPREAD_EVENT_PAIRS_PATH` or default `scripts/prediction_market_event_pairs.json`), ensure that file includes DEM and GOP nominee pairs (e.g. slugs `democratic-presidential-nominee-2028`, `republican-presidential-nominee-2028`).

3. **Missing pairs / provider_market_ref mismatches**
   - Kalshi ref = ticker (e.g. `KXPRESNOMD-28-GN`). Polymarket ref = `polymarketSlug#polymarketOutcomeName` (e.g. `democratic-presidential-nominee-2028#Gavin Newsom`).
   - In `lib/pmci-ingestion.mjs`, confirm how refs are set and that they match what the seeder and API expect (e.g. seeder matches markets by provider + ref; no ticker vs slug#outcome mismatch).
   - Identify any pair in the observer config that might not have a matching provider_market row (e.g. wrong slug, wrong outcome name, or API failure so snapshot never written).

**Files to inspect**

- `observer.mjs` (startup, loadEnv, createPmciClient, runOneCycle log line)
- `lib/pmci-ingestion.mjs` (createPmciClient, ingestPair, provider_market_ref construction)
- `event_pairs.json` and/or `scripts/prediction_market_event_pairs.json` (DEM/GOP coverage)
- `.env.example` or README (DATABASE_URL documented)
- `scripts/pmci-smoke.mjs` (what it counts)
- Supabase migrations under `supabase/migrations/` that create `pmci.provider_markets` and `pmci.provider_market_snapshots`

**Output artifact (required)**

Produce exactly one of:

- **Sanity checklist:** Bullet list of checks (e.g. "DATABASE_URL loaded in observer", "provider_markets and snapshots increase over time", "DEM and GOP slugs present in config", "provider_market_ref format: Kalshi=ticker, Polymarket=slug#outcome") with [ ] items and any concrete fixes (file + change) if a check fails.
- **PR plan + sanity checklist:** If you recommend code or config changes, add a short PR plan (files to touch, diff outline) and append the sanity checklist.

Return the artifact so the Coordinator can merge it into the Implementation Plan and trigger the next agent (RELATIONSHIP_MANAGER).
```

---

## Artifacts (to be merged after each agent run)

**Full run completed.** All agent artifacts (INGESTION_AUDITOR, RELATIONSHIP_MANAGER, VALIDATION_AGENT, REPORTER, WINDOW_SURGEON/CALIBRATION deferred) are merged in **`docs/plans/2025-02-25-pmci-e2e-RUN-RESULTS.md`**. Summary:

- **Ingestion:** Checklist done; ref format aligned; no code fixes. Blocker: run observer so provider_markets/snapshots > 0.
- **Relationship:** UUID flow, families, links, v_market_links_current aligned; no fixes.
- **Validation:** Acceptance test steps, SQL spot checks, and failure taxonomy documented.
- **Reporter:** Top-divergences spec (endpoint or script), schema, sorting formula, sanity checklist.
- **Window/Calibration:** Deferred until slice is stable.
