# Post-MM-MVP Parallel Execution — Master Prompt (rev 2026-05-01b)

> **Revision history:**
> - **rev a (2026-05-01 morning):** original; assumed Phase 0 (operational follow-through) and Track A (Polymarket Pre-W1+W1) had not started.
> - **rev b (2026-05-01 afternoon):** operator caught staleness — both Phase 0 and Track A had already shipped 2026-04-28 (ADR-008 + ADR-009). 7-day clock had been running for 3 days. Rev b reflects current reality: Phase 0 → state-verification pass; Track A → acknowledged-done with successor pointer to indexer W2; Tracks B/C/D → pruned to what's actually still open; new open questions added (44k kill_switch_events anomaly, ADR-008 drift).
>
> **For: Cursor (orchestrator agent in `~/prediction-machine`).**
> **Mode:** orchestrate Phase 0 yourself (verification only — do not execute), then **spawn one sub-agent per parallel track** for Tracks B, C, D. Track A is in maintenance mode — no sub-agent unless the operator explicitly opens Track A-successor (indexer W2).
> **Working repos:**
> - `~/prediction-machine` — backend (primary)
> - `~/lovable-ui` — frontend (Track B touches this)
> - `~/audits/post-pivot-review/` — read-only audit context
> - `~/Documents/Claude/Projects/Prediction Machine/` — vault (out of scope)

---

## 0. Mission

The MM MVP shipped feature-complete on 2026-04-28 (W6 commit `f099fd4`). The 7-day continuous-quote test on Kalshi DEMO is **currently running** — clock started **2026-04-28T17:41:28.638Z UTC** per ADR-008; today is **day 3 of 7**; window expires **~2026-05-05T17:41Z**. Polymarket indexer Pre-W1 + W1 also shipped 2026-04-28 (ADR-009, commit `2ab3160`). The operator wants:

1. **Phase 0 (orchestrator-only, verification):** Confirm the 7-day clock is still running cleanly, surface any anomalies (notably the 44,372 `mm_kill_switch_events` count and the 8-vs-5 market drift from ADR-008), and produce a state-snapshot the operator can read in 60 seconds.
2. **Phase 1 (parallel sub-agents):** While the clock continues to tick, run three independent workstreams concurrently:
   - **Track B — Sunset / cleanup tier 1** (arb-era code, schema, frontend dead code, secret rotation; **NOT vault wiki updates** — those are deferred)
   - **Track C — MM v2 prep** (research/design only; no live-path code)
   - **Track D — Open decisions write-up** (originally 8 questions from audit roadmap §6; rev b adds 2 new questions surfaced 2026-05-01)

Track A (Polymarket Pre-W1 + W1) is **DONE** as of commit `2ab3160` and ADR-009. A future Track A-successor (indexer W2: `pmci-poly-indexer` Fly app + live Polygon RPC ingestion) is **explicitly not in this prompt** — separate dispatch when the operator wants to start it.

---

## 1. Required reading

**Always:**
- `~/prediction-machine/CLAUDE.md` — CURRENT PHASE line is now "MM MVP 7-day validation, day 3 of 7"
- `~/prediction-machine/docs/decision-log.md` — ADRs 001–010 (ADR-010 captures the rotator drift from ADR-008)
- `~/prediction-machine/docs/system-state.md` — "Current status (2026-05-01)" block
- `~/audits/post-pivot-review/synthesis/post-pivot-roadmap.md` — original audit roadmap; §5 (cleanup) and §6 (open questions) still relevant
- `~/audits/post-pivot-review/synthesis/cross-cutting-findings.md` — BLOCKER/DEGRADER consolidation

**Track-specific:**
- Track B: `~/audits/post-pivot-review/agents/04-carryover-extraction/findings.md`, `~/audits/post-pivot-review/agents/05-database-state/findings.md`, `~/audits/post-pivot-review/agents/08-frontend-consumer/findings.md`
- Track C: `~/prediction-machine/docs/plans/phase-mm-mvp-plan.md` §"Out of scope for MVP" + §"Build sequence", `~/Documents/Claude/Projects/Prediction Machine/_inbox/thesis-brainstorm-kalshi-poly-structures.md`
- Track D: `~/audits/post-pivot-review/synthesis/post-pivot-roadmap.md` §6 (8 original questions) + this prompt's §5 (2 new questions added 2026-05-01)

---

## 2. Global invariants

- **Do not commit or push any branch without explicit operator approval.** Stage on feature branches; operator merges manually.
- **Branch naming:** `track-<X>-<short>` off current `main` (e.g., `track-b-archive-arb-backtest`, `track-c-mm-v2-prep`).
- **Do not modify** `~/Documents/Claude/Projects/Prediction Machine/` (the wiki vault). Wiki updates are deferred.
- **Do not touch `docs/archive/pivot-2026-04/`** except to *add* code being archived into it.
- **Do not pause, restart, or modify** any of the three running Fly apps (`pmci-api`, `pmci-observer`, `pmci-mm-runtime`) from a sub-agent. The 7-day clock is mid-flight.
- **Do not modify** `lib/mm/`, `lib/providers/kalshi-trader.mjs`, or any code path the running orchestrator imports.
- **Do not modify** `lib/poly-indexer/`, `lib/poly-indexer/clients/`, `scripts/lint/no-polymarket-write.mjs`, or migration `20260430130000_pmci_poly_w1.sql` — Track A is closed. If a Track B/C/D sub-agent finds it needs to touch these, surface to operator instead.
- **Active markets only for ingestion code** per `CLAUDE.md`.
- **Supabase project ref:** `awueugxrdlolzjzikero`. Use the Supabase MCP directly.
- **Migrations:** filename pattern `YYYYMMDDHHMMSS_<short_description>.sql`; apply via Supabase MCP `apply_migration`.
- **`npm run verify:schema` must PASS** at the end of any track that adds a migration.
- **`npm run lint:poly-write-guard` must PASS** at the end of any track (it's now part of the verify graph).

---

# PHASE 0 — State Verification (orchestrator-only, ~5 minutes)

> Phase 0 is now a **read-only verification pass**, not an execution sequence. The clock is running; the runtime is healthy; secrets are set. The job here is to confirm those things are still true and surface any anomalies before launching Phase 1 sub-agents.

## 0.1. Verify git + branch state

```bash
cd ~/prediction-machine
git status                           # expect clean tree on main
git log -1 --oneline                 # expect HEAD = 993e5c7 or descendant on 2026-05-01
git status -b                        # expect 'main...origin/main' with 0 ahead
```

If working tree is dirty or main is ahead of origin/main, **stop and surface** — Phase 1 sub-agents need a clean baseline.

## 0.2. Verify the three Fly apps are healthy

```bash
curl -sS https://pmci-api.fly.dev/v1/health/freshness | jq .
curl -sS https://pmci-mm-runtime.fly.dev/health/mm | jq .
fly status -a pmci-mm-runtime         # expect single-instance, healthy
```

**Acceptance:**
- `pmci-api`: `status=ok`, lag_seconds < 120 for both Kalshi and Polymarket
- `pmci-mm-runtime`: `ok=true`, `lastReconcileAt` within last 60s, `lastOrchestratorError=null`, `depthSubscribedConnected = depthSubscribedConfigured`
- `pmci-mm-runtime` Fly instance count = 1 (single-instance invariant)

If any of those fail, **stop and surface** — do not start Phase 1 work while the runtime is unhealthy.

## 0.3. Verify the 7-day clock is still ticking against the rotated universe

Via Supabase MCP, run:

```sql
-- Are there enabled markets quoting?
SELECT count(*) AS enabled_markets FROM pmci.mm_market_config WHERE enabled = true;
-- expect 5–8 (rotator may have just refreshed)

-- Last orders placed?
SELECT max(placed_at) AS last_order_at FROM pmci.mm_orders;
-- expect within last 5 minutes during DEMO trading hours

-- P&L snapshots flowing?
SELECT max(observed_at) AS last_pnl_snapshot FROM pmci.mm_pnl_snapshots;
-- expect within last 10 minutes

-- Clock-start sanity
SELECT min(committed_at) AS clock_started FROM pmci.mm_market_config WHERE enabled = true;
-- expect ≈ 2026-04-28T17:41Z (the ADR-008 timestamp, or rotator-refresh timestamp if newer)
```

## 0.4. Investigate the kill_switch_events anomaly

This is **new for rev b**. As of 2026-05-01 ~14:36Z, `pmci.mm_kill_switch_events` had **44,372 rows** since 2026-04-28. That's a fire every ~6 seconds for 3 days, which is implausibly high for normal MM operation.

Run:

```sql
-- Distribution by reason
SELECT reason, count(*) AS n, min(observed_at) AS first, max(observed_at) AS last
FROM pmci.mm_kill_switch_events
GROUP BY reason
ORDER BY n DESC;

-- Are they actually firing the kill action, or is it logspam?
SELECT count(*) FILTER (WHERE killed = true) AS actually_killed,
       count(*) FILTER (WHERE killed = false) AS logged_only
FROM pmci.mm_kill_switch_events;

-- Time-of-day clustering — is this a triage-period burst?
SELECT date_trunc('hour', observed_at) AS hr, count(*)
FROM pmci.mm_kill_switch_events
GROUP BY 1 ORDER BY 1 DESC LIMIT 24;
```

Three plausible explanations — pick the right one and report:
1. **Triage churn during 2026-04-29 W4 reconcile period** — events should cluster around the merge timestamps and have stopped by 2026-04-30.
2. **Soft-trip kill events used as monitoring signal** (not actual kills) — `killed=false` should dominate.
3. **Genuine kill-switch fires** with high frequency — would indicate a quoting-engine or risk-module bug; gates production cutover.

If (3), **flag as BLOCKER for production cutover** in your Phase 0 report. Do not attempt to fix from this orchestrator pass; surface to operator and let them decide whether to investigate now or after the 7-day clock closes.

## 0.5. Verify Track A artifacts are intact (do not modify)

```bash
ls lib/poly-indexer/clients/                       # index.mjs, polygon-rpc.mjs, polymarket-subgraph.mjs
ls lib/poly-indexer/reorg.mjs                      # exists
ls scripts/lint/no-polymarket-write.mjs            # exists
grep -q '"lint:poly-write-guard"' package.json     # exists
ls supabase/migrations/20260430130000_pmci_poly_w1.sql  # exists
npm run lint:poly-write-guard                      # PASS
```

Then via Supabase MCP:

```sql
SELECT count(*) FROM pmci.poly_wallet_trades;       -- expect 0 (W2 not started)
SELECT count(*) FROM pmci.poly_market_flow_5m;      -- expect 0
SELECT count(*) FROM pmci.poly_indexer_cursor;      -- expect 1 (initialized) or 0 (uninitialized)
```

If any of these are missing or fail, **stop and surface** — that means commit `2ab3160` was reverted, which would be a major operational event the operator needs to know about.

## 0.6. Phase 0 Final Report (orchestrator emits before launching Phase 1)

```
PHASE 0 STATE VERIFICATION (2026-05-XX HH:MMZ)

Git:                  clean / dirty | HEAD <sha> | main vs origin: <status>
pmci-api:             healthy / degraded | freshness lag: <s>
pmci-observer:        healthy / degraded
pmci-mm-runtime:      healthy / degraded | reconcile phase: <W4|W5> | loopTick: <n>
                      | depth subscriptions: <connected>/<configured>
                      | depth staleness: <range>
7-day clock:          running | day <X> of 7 | started <UTC ts> | expires <UTC ts>
Enabled markets:      <count> (vs ADR-008 baseline of 5; rotator drift documented in ADR-010)
mm_orders:            <count>
mm_fills:             <count>
mm_kill_switch_events:<count>  ← INVESTIGATE if >1000
  reason distribution: <top reasons + counts>
  actually killed:    <count>
  logged_only:        <count>
  verdict:            triage_churn | soft_trip_signal | genuine_kill_fires_BLOCKER

Track A artifacts:    intact / missing
Poly W1 tables:       <row counts>
lint:poly-write-guard:PASS / FAIL

ANOMALIES:
- <list anything off-pattern>

GATE: PROCEED to Phase 1 | HOLD until anomaly resolved
```

If GATE = HOLD, **stop and report to operator.** Phase 1 should not start while there's an unresolved anomaly that could affect the 7-day verdict.

---

# PHASE 1 — Parallel Workstreams (3 sub-agents)

> Spawn one sub-agent per track concurrently. Each track is self-contained; sub-agents must not block on each other. Sub-agents commit locally on named branches and stop — operator pushes after review.

---

## TRACK A — DONE (no sub-agent)

**Status:** ✅ COMPLETE as of commit `2ab3160` (2026-04-28). ADR-009 records the decision.

**Shipped:**
- `lib/poly-indexer/clients/{index.mjs, polygon-rpc.mjs, polymarket-subgraph.mjs}` — read-only client namespace
- `lib/poly-indexer/reorg.mjs` — fork-choice + dual-watermark + orphan semantics + panic mode
- `scripts/lint/no-polymarket-write.mjs` + `npm run lint:poly-write-guard` — CI guard
- Migration `20260430130000_pmci_poly_w1.sql` — `pmci.poly_wallet_trades` (RANGE block_number partitioned), `pmci.poly_market_flow_5m` (RANGE bucket_start partitioned), `pmci.poly_indexer_cursor` (head/final dual watermark), `pmci.poly_resolved_markets` (winner index + resolution block); all four use REVOKE-anon/authenticated + GRANT service_role pattern
- Test coverage in `test/poly-indexer/` (unit tests for reorg state machine + lint-guard fixtures)

**Track A successor — NOT in this prompt:**
- W2 (live ingestion) requires: `pmci-poly-indexer` Fly app, Polygon RPC + WS subscription, subgraph-first historical backfill, idempotent insert with confirmation-delay reorg handling. Plan reference: `docs/plans/phase-poly-wallet-indexer-plan.md` §"Build sequence" steps 2 onwards. Open as a separate dispatch when operator decides.

---

## TRACK B — Sunset / Cleanup Tier 1

**Branches (multiple small ones — easier to review):**
- `track-b-archive-arb-backtest`
- `track-b-archive-arb-job-orphans`
- `track-b-drop-empty-arb-tables`
- `track-b-truncate-proposed-links`
- `track-b-frontend-deadcode` (in `~/lovable-ui`)
- `track-b-rotate-migration-secrets`
- `track-b-deprecate-arb-endpoints-openapi`
- `track-b-fix-doc-drift`

**Effort:** 1 sub-agent, multi-turn; mostly mechanical. **EXPLICITLY OUT OF SCOPE:** vault wiki updates (`~/Documents/Claude/Projects/Prediction Machine/`); `99-sources/` re-snapshot; vault frontmatter changes. Operator deferred those for a separate dedicated pass.

### B.1. Archive arb-era backtest code

Branch: `track-b-archive-arb-backtest`

Move (do not copy-and-leave):
- `lib/backtest/*.mjs` (8 files: aggregate, arb-trade, equivalence-csv, leg-payout, leg-resolver, run-engine, template, types) → `docs/archive/pivot-2026-04/code/lib/backtest/`
- `scripts/backtest/run-backtest.mjs` → `docs/archive/pivot-2026-04/code/scripts/backtest/`
- `test/backtest/*.test.mjs` (6 files) → `docs/archive/pivot-2026-04/code/test/backtest/`

After move:
- Grep the live tree for any remaining import of `lib/backtest/` — if found, surface as a regression.
- Update `package.json`: remove any npm script referencing the moved paths.
- Verify `npm test` still passes; the moved tests must not fail the live test graph (drop them from the test glob).

**Note:** The pre-existing test debt in `test/backtest/leg-payout.test.mjs` (per 2026-04-28 decision-log entry) is resolved by archiving — confirm and call it out in the Final Report.

### B.2. Drop arb-era JOB_MAP orphans

Branch: `track-b-archive-arb-job-orphans`

Targets (still live as of 2026-05-01):
- `auto-accept`, `auto-accept:audit`, `auto-link` entries in `supabase/functions/pmci-job-runner/index.ts` JOB_MAP (lines 17–22)
- Same names in `ADMIN_JOBS` constant in `src/routes/admin-jobs.mjs` (lines 24–29)
- Any pg_cron rows scheduling these jobs (query `cron.job` via Supabase MCP first; emit a migration deleting them)

Verify post-change: `curl -sS -H "X-PMCI-API-KEY: $PMCI_API_KEY" https://pmci-api.fly.dev/v1/admin/jobs/auto-accept` returns 404, not 200.

**CRITICAL — destructive deploy ordering** (per memory `feedback_destructive_migration_ordering.md`):
1. Stage code change first; deploy `pmci-api` with the JOB_MAP/ADMIN_JOBS rows removed.
2. AFTER deploy succeeds, apply the migration deleting pg_cron rows.
3. Reverse order risks pg_cron firing into a jobname the running api doesn't know.

### B.3. Drop empty arb-era tables

Branch: `track-b-drop-empty-arb-tables`

Migration `<ts>_drop_empty_arb_tables.sql`:
```sql
DROP TABLE IF EXISTS pmci.unmatched_markets;
DROP TABLE IF EXISTS pmci.link_gold_labels;
DROP TABLE IF EXISTS pmci.linker_runs;
DROP TABLE IF EXISTS pmci.linker_run_metrics;
```

**Pre-flight:** for each table, run `SELECT count(*) FROM <t>` via Supabase MCP. If any row count > 0, **stop and surface** — the audit listed them as zero-row, but verify before dropping.

### B.4. Archive then TRUNCATE proposed_links

Branch: `track-b-truncate-proposed-links`

Two distinct steps with verification between:
1. Export `pmci.proposed_links` to `docs/archive/pivot-2026-04/data/proposed_links_2026-05-XX.csv.gz`. Commit the archive.
2. Verify dump row count matches live row count.
3. Apply migration `<ts>_truncate_proposed_links.sql`:
   ```sql
   TRUNCATE pmci.proposed_links;
   ```
4. Verify count = 0.

**Do NOT drop the table** — leaves the door open if a future arb thesis on a different provider pair is ever opened.

### B.5. Frontend dead code removal (lovable-ui)

Branch: `track-b-frontend-deadcode` **in `~/lovable-ui`, not prediction-machine.**

Targets (note: `pages/Index.tsx` was already removed at some point — verify state first):
- 5 dead children: `ArbitrageScanner`, `MarketMonitor`, `MarketDetail`, `StatusBar`, `ApiKeyModal`
- `lib/api.ts` and the dead types it owns
- `ArbitrageDashboard` — operator preference is delete; if sub-agent finds live wire-up, surface and ask

**Process per file:** `grep -rn "<Name>" src/` to confirm zero live imports → if found in live routes, **stop and surface** → otherwise delete → run `npm run build` and confirm tree is clean.

**Open question for operator:** is `MMDashboard` sanctioned operator surface? Per audit agent 08 R4, it was built before the plan authorized it. If sanctioned, it needs rewiring to the MM-truth tables (`provider_market_depth`, `mm_pnl_snapshots`, etc.). If not, delete in this same branch.

lovable-ui auto-syncs with `jayjohn18000/prediction-hub`; sub-agent stages on a branch and stops — operator pushes after review.

### B.6. Rotate migration secrets

Branch: `track-b-rotate-migration-secrets`

Two old migrations contain hardcoded Supabase anon JWT and `PMCI_API_KEY`:
- `supabase/migrations/20260418124500_pmci_health_poll_via_job_runner.sql`
- `supabase/migrations/20260416041305_pmci_auto_review_cron.sql`

**These migrations are already applied** — editing them does not re-run. Process:
1. Generate replacement JWT + replacement PMCI_API_KEY (operator action — surface and request).
2. Update Supabase secrets and Fly secrets on `pmci-api`, `pmci-observer`, `pmci-mm-runtime`.
3. Apply a new migration that updates any pg_cron rows referencing old credentials.
4. Edit the old migration files to redact secrets to `<REDACTED — rotated YYYY-MM-DD>` for git-history hygiene going forward.

**Git-history rewrite (BFG / git-filter-repo) is operator's call** — do not perform without explicit approval.

### B.7. Tag arb-era endpoints `deprecated: true` in OpenAPI

Branch: `track-b-deprecate-arb-endpoints-openapi`

In `docs/openapi.yaml`, add `deprecated: true` and a `Sunset:` header annotation for:
- `/v1/signals/divergence`
- `/v1/signals/top-divergences`
- `/v1/signals/event/:eventRef`
- `/v1/snapshots`
- `/v1/review/queue`, `/v1/review/decision`, `/v1/review/batch`
- `/v1/coverage`, `/v1/coverage/summary`

Set Sunset = **2026-08-01**.

Also fix `docs/api-reference.md:42` drift on `/v1/signals/top-divergences` (or delete the section if endpoint is being deprecated).

### B.8. Fix doc drift in db-schema-reference.md

Branch: `track-b-fix-doc-drift`

Walk `docs/db-schema-reference.md`, cross-check column types via Supabase MCP `list_tables`, patch every drift. Add "Last verified: 2026-05-XX (Track B sub-agent)" at top.

### B.9. Track B Verification

```bash
cd ~/prediction-machine
npm run verify:schema           # PASS
npm run pmci:smoke              # PASS
npm run lint:poly-write-guard   # PASS (must still pass after Track B changes)
npm test                        # PASS

cd ~/lovable-ui
npm run build                   # PASS
```

### B.10. Track B Final Report

```
TRACK B STATUS: OK | DEGRADED | BLOCKED
- Branches landed: <list>
- LOC removed (live tree): <number>
- Tables dropped: <list>
- Tables truncated: <list>
- proposed_links archive size: <bytes>
- Frontend components removed: <list>
- OpenAPI endpoints tagged deprecated: <count>
- Migrations applied: <list>
- All gates: PASS / FAIL
- Items surfaced to operator (secrets rotation, git-history rewrite, MMDashboard fate): <list>
- Items deferred (with reason): <list>
- Wiki updates: NOT TOUCHED (per operator direction)
```

---

## TRACK C — MM v2 Prep (research/design only)

**Branch:** `track-c-mm-v2-prep` (single branch)
**Effort:** 1 sub-agent, multi-turn; pure synthesis.

**Hard constraint:** no edits to `lib/mm/`, `lib/providers/kalshi-trader.mjs`, or anything in `lib/poly-indexer/`. This track produces docs only, all under `docs/plans/mm-v2/` (new directory).

### C.1. Statistical fair-value model interface spec

Output: `docs/plans/mm-v2/01-statistical-fair-value-interface.md`

- Document the v0 interface contract precisely from current `lib/mm/fair-value.mjs`. This is what v2 must preserve.
- For each in-MVP category (sports, politics, crypto, economics): one-page model sketch. What features? Simplest model that beats EMA+Poly? What training data exists or could be ingested cheaply?
- Identify per-event-type sub-models (NBA win-totals vs MLS match-winner, NHL series vs single-game NHL, etc.).
- Cross-reference brainstorm doc thesis #1 ("statistical model edge") and explicitly map how v2 fair-value subsumes that thesis — same code path.
- Spec a v0→v2 migration plan: runtime selects implementation per `mm_market_config.fair_value_version` column. Spec the column.

### C.2. Universe-selection rubric

Output: `docs/plans/mm-v2/02-universe-selection-rubric.md`

- Catalog inputs available today per Kalshi market (read from `pmci.provider_markets`).
- Propose 5–8 candidate features. For each: hypothesize sign + magnitude of effect on MM profitability.
- Sketch scoring function (linear weighted sum is fine for v2.0).
- Define cutoff. Compute the rubric's score for the **current 8 enabled markets** (per the rotator drift — ADR-010) and use that as a floor.
- Identify additional data the Polymarket indexer W2 would contribute: per-market sharp/degen flow volume, recent toxicity, etc.
- Spec how the rubric runs (cron? on-demand? via API?) and where it writes (`mm_market_universe_candidates` table — schema sketch in this doc).

**Do NOT implement.** Spec only.

### C.3. MM-flavored backtest engine spec

Output: `docs/plans/mm-v2/03-mm-backtest-engine-spec.md`

The arb-era `lib/backtest/` is being archived in Track B. The MM-flavored engine is net-new and was deferred from W6. By the time this spec is operationalized, the 7-day window will have completed and there will be real depth + fill history to calibrate against.

- Replay model over historical `provider_market_depth` snapshots
- Fill model: trade-print history from Kalshi (which we don't currently ingest — flag as a precondition)
- Adverse-selection sim from historical post-fill price movement
- Output schema must match live `mm_pnl_snapshots` decomposition exactly
- Validation: engine is calibrated when its replay of the just-completed 7-day window reproduces live `mm_pnl_snapshots` within ±5% per market per day
- Sequencing: which weeks of W2-spec'd ingestion does the backtest depend on?

### C.4. Open futures-account decision memo

Output: `docs/plans/mm-v2/04-futures-account-decision-memo.md`

- What hedging strategies become available (CME equity index, CME crypto, ZN/ZB rates, etc.)? Match each to a Kalshi MM market category.
- Capital efficiency comparison: same dollar in MM book vs same dollar in futures hedge.
- Operational complexity: separate broker, SPAN margin, regulatory reporting.
- Recommendation: defer or proceed; expected value of each path with rough numbers.

This is decision-support, not a decision. Operator answers in Track D's open-questions doc.

### C.5. Track C Verification + Final Report

```bash
ls docs/plans/mm-v2/                           # 4 files exist
npx markdownlint docs/plans/mm-v2/*.md
```

Every doc has YAML frontmatter (`title`, `status: draft`, `last-verified: 2026-05-XX`, `sources:`). Every code path referenced exists today.

```
TRACK C STATUS: OK | DEGRADED | BLOCKED
- Branch: track-c-mm-v2-prep
- Docs produced: 4 / 4
- Total LOC docs: <number>
- Open questions surfaced for operator: <list with section refs>
- Inputs that don't exist yet (e.g., trade prints): <list>
- Recommendation summary: <one paragraph per doc>
```

---

## TRACK D — Open Decisions Write-Up

**Branch:** `track-d-open-decisions`
**Effort:** 1 sub-agent, single-turn most likely.

The audit roadmap §6 has 8 questions only the operator can decide. Rev b adds **2 new questions** surfaced 2026-05-01.

### D.1. Output

`docs/plans/2026-05-XX-open-decisions-for-jay.md` (single file).

Format per question:

```markdown
## Q<n>. <restated in one sentence>

**Audit recommendation:** <YES/NO/specific>
**Audit evidence:** <2-3 sentences; cite agent NN §X.Y or ADR-N>

**Sub-agent synthesis (extra context the audit didn't have):**
<1 paragraph>

**If you trust the audit → answer:** <one word>
**If you want to think differently, the relevant tension is:** <1-2 sentences>

**Your answer:** [ ]
```

### D.2. Original 8 questions (from audit roadmap §6)

1. `costs.mjs` carryover claim → replace with direct `fees.kalshi.mjs::kalshiFeeUsdCeilCents` import?
2. `polymarket-snapshot-recovery.mjs` carryover → restate as MM-only niche helper (drop indexer claim)?
3. `v_polymarket_latest_prices` ownership → observer-side or indexer-side? **(Note: per `_FINAL_STATE_2026-04-28.md`, this view shipped Pre-W2 #2 as observer-side — confirm and mark resolved.)**
4. `/health/mm` admin probe → on `pmci-api` or separate Fastify on `pmci-mm-runtime`? **(Note: live state shows separate Fastify at `pmci-mm-runtime.fly.dev/health/mm` — confirm and mark resolved.)**
5. CLAUDE.md invariant "MM operational signaling never goes through fire-and-forget cron" → adopt?
6. `pmci.providers.last_snapshot_at` → drop denormalization vs wire all writers? **(Note: per Pre-W2 #5 in `_FINAL_STATE_2026-04-28.md`, denormalization was dropped — confirm and mark resolved.)**
7. lovable-ui in MM scope or not? **(Track B.5 surfaces MMDashboard fate — operator decides here.)**
8. Phase G ops scripts still being run? (gates Track B tier-2 cleanup)

### D.3. New questions added 2026-05-01 (rev b)

9. **44k mm_kill_switch_events anomaly:** is this triage churn (resolved), monitoring signal (intentional), or genuine kill-fires (production-blocker)? Phase 0 verification will produce diagnostic data — sub-agent should reference whatever Phase 0 found and recommend a path: ignore / instrument / investigate-now / investigate-after-7-day-clock.

10. **ADR-008 vs ADR-010 reconciliation:** the 7-day test design drifted from "5 markets static" to "8 markets + daily rotator." ADR-010 documents the drift retroactively. Is ADR-010's framing acceptable, or does the operator want to revise ADR-008 directly (single source of truth) instead of leaving two ADRs in tension? Affects how the post-W6 audit interprets the validation outcome.

### D.4. Verification + Final Report

Single doc exists; renders cleanly; **10 questions** (8 original + 2 new) covered; each has all four sections; YAML frontmatter present.

```
TRACK D STATUS: OK | DEGRADED | BLOCKED
- Doc produced: docs/plans/2026-05-XX-open-decisions-for-jay.md
- Questions covered: 10 / 10
- Original audit questions confirmed already-resolved by post-Pre-W2 work: <list>
- New 2026-05-01 questions: 2 (kill_switch anomaly, ADR-008/010 reconciliation)
- Sub-agent disagreements with audit: <count, with refs>
- Recommended ordering for operator review: <list>
```

---

# Final Orchestrator Report (after all 3 sub-agents return)

```
PARALLEL EXECUTION FINAL REPORT (rev b — 2026-05-XX)

PHASE 0:    PASS / FAIL (state verification, not execution)
            7-day clock day <X> of 7; expires <UTC ts>
            Anomalies found: <list>
TRACK A:    DONE (acknowledged; no action this session)
TRACK B:    OK | DEGRADED | BLOCKED — branches: <list>
TRACK C:    OK | DEGRADED | BLOCKED — branch: track-c-mm-v2-prep
TRACK D:    OK | DEGRADED | BLOCKED — branch: track-d-open-decisions

UNPUSHED BRANCHES READY FOR REVIEW:
- track-b-archive-arb-backtest                 (~prediction-machine)
- track-b-archive-arb-job-orphans              (~prediction-machine)
- track-b-drop-empty-arb-tables                (~prediction-machine)
- track-b-truncate-proposed-links              (~prediction-machine)
- track-b-frontend-deadcode                    (~lovable-ui)
- track-b-rotate-migration-secrets             (~prediction-machine)  [secrets pending operator]
- track-b-deprecate-arb-endpoints-openapi      (~prediction-machine)
- track-b-fix-doc-drift                        (~prediction-machine)
- track-c-mm-v2-prep                           (~prediction-machine)
- track-d-open-decisions                       (~prediction-machine)

ITEMS REQUIRING OPERATOR ACTION:
- <list — e.g. approve secrets rotation, decide MMDashboard fate, decide kill_switch root-cause path>

ITEMS DELIBERATELY DEFERRED:
- All vault wiki updates (~/Documents/Claude/Projects/Prediction Machine/)
- Track A successor (Polymarket indexer W2: pmci-poly-indexer Fly app + live ingestion)
- Tier-2 cleanup (post-MM-MVP-stable bucket from roadmap §5)
- Tier-3 cleanup (only-after-thesis-validated bucket from roadmap §5)
- Production cutover from Kalshi DEMO to live Kalshi (gated on 7-day verdict + kill_switch investigation)

7-DAY CLOCK:
- Day <X> of 7
- Started: 2026-04-28T17:41:28.638Z
- Expires: ~2026-05-05T17:41Z
- Health at orchestrator-end: <pmci-mm-runtime status>

NEXT-AUDIT TRIGGER:
- Post-7-day verdict (whether streak passes or fails) — full agent set re-review
- Earlier if kill_switch investigation surfaces a production-blocker
```

---

# Appendix A — Sub-agent dispatch boilerplate

```
You are a sub-agent dispatched by the Cursor orchestrator working in
~/prediction-machine. The 7-day MM validation clock is RUNNING; do not
modify the running services. Read these files first:

1. ~/prediction-machine/CLAUDE.md
2. ~/audits/post-pivot-review/synthesis/post-pivot-roadmap.md
3. ~/audits/post-pivot-review/synthesis/cross-cutting-findings.md
4. ~/prediction-machine/docs/decision-log.md (especially ADR-008, ADR-009, ADR-010)
5. <track-specific reading list>

Then execute Track <X> (B | C | D) from
~/prediction-machine/docs/cursor-prompts/2026-05-01-post-mm-mvp-parallel-execution.md
(rev b — 2026-05-01 afternoon)

Hard rules:
- Do not push to origin. Stage on the named branch and stop.
- Do not modify the wiki at ~/Documents/Claude/Projects/Prediction Machine/.
- Do not modify lib/mm/, lib/providers/kalshi-trader.mjs, or any code the
  running orchestrator imports.
- Do not modify lib/poly-indexer/ — Track A is closed.
- Do not pause, restart, or modify any of the three Fly apps (pmci-api,
  pmci-observer, pmci-mm-runtime) — the 7-day clock is mid-flight.
- If you encounter a precondition failure, stop and surface to the
  orchestrator. Do not work around it.
- Return your Final Report in the exact format the track section specifies.
```

---

# Appendix B — Why parallelism is safe (rev b)

- **A is done** — no concurrent edits possible.
- **B writes to live arb-era schema/code being archived; nothing in C/D reads it.**
- **C produces docs only.**
- **D produces one doc.**
- **None of B/C/D touches `lib/mm/`, `lib/poly-indexer/`, or the running Fly apps.** The 7-day clock keeps running.

Synchronization point is the Final Report assembly. If two tracks both edit `package.json` or `docs/decision-log.md`, second sub-agent will hit a merge conflict on its branch — surface and rebase.

---

# Appendix C — What rev b does NOT do

- Does not start MM W7+ (post-streak work). Separate dispatch after the 7-day verdict.
- Does not start Polymarket indexer W2 (live ingestion). Separate dispatch after operator opens Track A-successor.
- Does not update the wiki vault.
- Does not push branches or merge to main.
- Does not contact external services beyond the already-running connections (Kalshi DEMO + Supabase + Fly + read-only Polygon RPC + read-only Polymarket subgraph).
- Does not execute trades or move money. (Demo-only; production cutover is a separate post-validation ADR.)

---

End of master prompt rev b.
