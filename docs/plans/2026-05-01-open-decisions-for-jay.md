---
title: Open decisions for Jay (post-MM-MVP, 2026-05-01)
status: draft
last-verified: 2026-05-01
sources:
  - audits/post-pivot-review/synthesis/post-pivot-roadmap.md (section 6)
  - docs/decision-log.md (ADR-008, ADR-009, ADR-010, 2026-05-01 master-prompt rewrite)
  - prediction-machine/CLAUDE.md (three-axis status, deployment table, invariants)
  - docs/plans/phase-mm-mvp-plan.md (carryover section, Contract R7)
  - supabase/migrations/20260427120001_pmci_v_polymarket_latest_prices.sql
  - supabase/migrations/20260427120003_pmci_drop_health_denormalizations.sql
  - scripts/mm/run-mm-orchestrator.mjs (Fastify /health/mm)
  - deploy/fly.mm.toml (health_check path /health/mm)
  - lib/mm/pnl-attribution.mjs
  - lib/execution/costs.mjs, lib/execution/fees.kalshi.mjs
  - lib/backfill/polymarket-snapshot-recovery.mjs
  - package.json (pmci:* scripts for scripts/review, scripts/ops, scripts/classify)
---

<!-- markdownlint-disable MD013 -->

This note distills the eight operator-only questions from the post-pivot roadmap section 6 into a single checklist. Use it as a **decision queue**: each section restates the question, quotes the audit position, adds only **net-new** repo context (not a repeat of the audit), and leaves `Your answer` blank for you to fill. Questions that Pre-W2 work already resolved in code are still listed so you can confirm and close them mentally; inline verification lines point at migrations and runtime entrypoints you can spot-check in one minute.

## Q1. Should the MM plan treat fee math as a direct `kalshiFeeUsdCeilCents` import instead of a `costs.mjs` carryover?

**Audit recommendation:** YES — use `fees.kalshi.mjs::kalshiFeeUsdCeilCents` for MM per-fill accounting; most of `costs.mjs` (lockup, slippage, Poly fees) is not needed for MM.

**Audit evidence:** The pivot carryover review positions `costs.mjs::estimateCost` as premium-USD-per-leg oriented, while MM naturally keys on `(price_cents, size_contracts)`; fee logic is already factored in `fees.kalshi.mjs` (agent 04 section 2b, roadmap section 6 Q1).

**Sub-agent synthesis (extra context the audit didn't have):**
Live P&L attribution already imports `kalshiFeeUsdCeilCents` from `lib/execution/fees.kalshi.mjs` in `lib/mm/pnl-attribution.mjs`, while `lib/execution/costs.mjs` still re-exports the same primitive inside `estimateCost` for arb-era callers. The **remaining gap is documentary**: `docs/plans/phase-mm-mvp-plan.md` still names `costs.mjs` under “Carryover” and in Contract R7’s `fees_cents` bullet; updating those strings to `fees.kalshi.mjs` (or “same implementation as `pnl-attribution`”) would align the plan with the shipped code path.

**If you trust the audit → answer:** YES

**If you want to think differently, the relevant tension is:**
Keeping `costs.mjs` as the named indirection preserves one import for future multi-venue fee tables, but it blurs MM’s actual dependency and leaves the pivot-era module in the narrative longer than necessary.

**Your answer: [x] YES** — trust the audit; update `phase-mm-mvp-plan.md` Carryover + Contract R7 prose to reference `fees.kalshi.mjs` directly.

## Q2. Should `polymarket-snapshot-recovery.mjs` be restated as an MM-only niche helper with no indexer backfill claim?

**Audit recommendation:** YES — describe it as a CLOB REST historical series tool for observer snapshots; drop any implication it serves the Polygon wallet indexer pipeline.

**Audit evidence:** Indexer backfill is on-chain log walking; snapshot-recovery is off-chain REST price history — no technical overlap (agent 04 section 2c, agent 01 section G8, roadmap section 6 Q2).

**Sub-agent synthesis (extra context the audit didn't have):**
The implementation remains at `lib/backfill/polymarket-snapshot-recovery.mjs` with CLI at `scripts/backfill/`; lint allowlists treat it as a special case (`scripts/lint/no-polymarket-write.mjs`). `docs/plans/phase-mm-mvp-plan.md` line 298–299 **still says** it is “useful when the Poly wallet indexer is backfilling,” which contradicts ADR-004’s indexer design ( subgraph/RPC ingestion, not `provider_market_snapshots` time series ). That sentence is exactly what the audit asked you to retract from planning prose.

**If you trust the audit → answer:** YES

**If you want to think differently, the relevant tension is:**
Naming it “MM helper” might understate legitimate one-off forensic backfill uses — but those uses are still observer/PMCI snapshot repair, not indexer W2.

**Your answer: [x] YES** — trust the audit; retract the indexer claim from `phase-mm-mvp-plan.md` lines 298–299.

## Q3. Should `v_polymarket_latest_prices` be owned observer-side or indexer-side?

**Audit recommendation:** Observer-side — data ownership matches `provider_market_snapshots`, which the observer fills.

**Audit evidence:** Roadmap section 6 Q3 and Pre-W2 checklist row 2 (agents 01, 02, 03 versus 05); parallel spine notes MM W3 reads the view while the indexer does not write it.

**Sub-agent synthesis (extra context the audit didn't have):**
**Verified resolved in-tree:** migration `supabase/migrations/20260427120001_pmci_v_polymarket_latest_prices.sql` defines the view over `pmci.provider_market_snapshots` joined to Polymarket provider rows, with COMMENT stating it is “populated implicitly by the observer.” No indexer migration defines an alternate owner.

**If you trust the audit → answer:** YES

**If you want to think differently, the relevant tension is:**
Agent 03’s indexer-leaning framing (roadmap section 6) is moot unless you intentionally move Poly mid storage into indexer-owned tables later — that would be a new ADR, not this view’s current ownership.

**Your answer: [x] YES — RESOLVED** — observer-side already shipped (migration `20260427120001_pmci_v_polymarket_latest_prices.sql`). Closed.

## Q4. Should the `/health/mm` admin probe live on `pmci-api` as `/v1/health/mm` or on a separate Fastify attached to `pmci-mm-runtime`?

**Audit recommendation:** Separate Fastify on `pmci-mm-runtime` at `/health/mm` — matches single-instance orchestrator lifecycle vs multi-instance API.

**Audit evidence:** Roadmap section 6 Q4 / agent 06 R5.

**Sub-agent synthesis (extra context the audit didn't have):**
**Verified resolved in-tree:** `scripts/mm/run-mm-orchestrator.mjs` mounts `app.get("/health/mm", ...)`, Fly config `deploy/fly.mm.toml` sets `health_check.path = "/health/mm"`; CLAUDE.md deployment table lists `https://pmci-mm-runtime.fly.dev` as the orchestrator URL with `/health/mm`. Dashboard reads remain on `pmci-api` under `/v1/mm/*`; health is intentionally colocated with the singleton process.

**If you trust the audit → answer:** YES

**If you want to think differently, the relevant tension is:**
Centralizing all health URLs on `pmci-api` is operationally fewer hostnames — but obscures reconcile/depth truth that exists only inside the MM process.

**Your answer: [x] YES — RESOLVED** — separate Fastify on `pmci-mm-runtime` already shipped (`scripts/mm/run-mm-orchestrator.mjs`, `deploy/fly.mm.toml`). Closed.

## Q5. Should CLAUDE.md adopt an explicit invariant that MM operational signaling never uses fire-and-forget cron / `child.unref()`-style dispatch?

**Audit recommendation:** YES — cron success bits do not prove side-effect success; MM kill-switch resets and similar actions cannot rely on that pattern if you hold a “zero spurious risk” bar.

**Audit evidence:** Agent 07 Gap E / R4, roadmap section 6 Q5 (`pmci.health_log` false success history).

**Sub-agent synthesis (extra context the audit didn't have):**
`CLAUDE.md` already warns that **cron writers need DB proof** (“Pattern 4 / fire-and-forget operational dispatch”) for MM-related jobs (`pmci-mm-*` in JOB_MAP); it does **not** yet spell the stronger rule the audit proposes: that **privileged MM administrative signaling** (e.g. kill-switch acknowledgement paths, if ever automated) must be synchronous/durable-call shaped rather than spawn-and-forget. MM observability workloads (PnL snapshots, heartbeat verifiers) can still legitimately be cron-shaped if each run proves row landing — the invariant is narrower than “no cron anywhere.”

**If you trust the audit → answer:** YES

**If you want to think differently, the relevant tension is:**
Formalizing “never” risks blocking benign background maintenance unless you carve out explicitly allowed cron categories (metric writers vs control plane).

**Your answer: [x] YES** — adopt the invariant; scope is the narrower one the sub-agent synthesized: privileged MM administrative signaling (kill-switch acks, position-snapshot triggers) must be synchronous/durable; observability cron jobs that prove row landing remain allowed.

## Q6. Should `pmci.providers.last_snapshot_at` be dropped (live-compute) or retained by wiring every writer to `touchProvidersLastSnapshotAt`?

**Audit recommendation:** Drop denormalization; live-compute `MAX(observed_at)` / indexed paths; migration autovacuum tune carries the perf story.

**Audit evidence:** Agents 01 R3, 07 R1/R2, 05 section 3-ops, roadmap section 6 Q6 aligned with roadmap section 2 row 5.

**Sub-agent synthesis (extra context the audit didn't have):**
**Verified resolved in-tree:** `supabase/migrations/20260427120003_pmci_drop_health_denormalizations.sql` executes `ALTER TABLE pmci.providers DROP COLUMN IF EXISTS last_snapshot_at` with rationale pointing at live-compute. `grep` shows no operational `touchProvidersLastSnapshotAt` path remaining in scripts (prior denormalization migration `20260424120001_pmci_providers_last_snapshot_at.sql` is historical only).

**If you trust the audit → answer:** YES

**If you want to think differently, the relevant tension is:**
If global max snapshot queries regress in latency, operators might revive a narrower materialized summary — separate from resurrecting column-level drift on providers.

**Your answer: [x] YES — RESOLVED** — denormalization dropped (migration `20260427120003_pmci_drop_health_denormalizations.sql`). Closed.

## Q7. Is `lovable-ui` in-scope for MM MVP operator surfaces, or out-of-scope?

**Audit recommendation:** Decide explicitly — MMDashboard today may be teaching a false mental model unless rewired to MM-truth tables; if sanctioned, rewire (`provider_market_depth`, `mm_pnl_snapshots`, etc.). (Agents 08 R1 + R4, roadmap section 5 “After-MM-MVP-stable”; parallel master prompt Track B.5 ties this to frontend cleanup.)

**Audit evidence:** Roadmap section 6 Q7 frames the sanctioned-versus-unsanctioned fork for MMDashboard; master prompt Track B notes the same fate question.

**Sub-agent synthesis (extra context the audit didn't have):**
`AGENTS.md` already lists `lovable-ui` as the active UI repo versus legacy `pmci-dashboard`. This workspace path was not opened in this pass; the decision stays product/operator scope regardless of backend readiness. Choosing “out-of-scope until Phase 1” matches the external orchestrator brief in CLAUDE (Phase 0 forbids polishing marketing/visual surfaces inside MM Engineering time).

**If you trust the audit → answer:** decide-explicitly

**If you want to think differently, the relevant tension is:**
Keeping a live dashboard lowers operational blindness during the seven-day demo, even if prettiness is deferred — but inaccurate wiring trades one risk for another.

**Your answer: [x] OUT-OF-SCOPE** — `lovable-ui` is not in MM MVP scope. The Track B.5 deletion of `MarketMakingDashboard.tsx` stands; Q7-placeholder dashboard remains until Phase 1 per the post-MM creative-practice roadmap.

## Q8. Are Phase G ops scripts (`scripts/review/*`, `scripts/ops/pmci-auto-link-pass.mjs`, `scripts/classify/*`) still run on any cadence?

**Audit recommendation:** Jay-owned operational yes/no answer; roadmap section 6 Q8 gates `lib/matching/` and bilateral-schema archival in the “Only-after-thesis-validated” bucket.

**Audit evidence:** Agent 04 section 10 open question 3 — cannot derive cadence solely from repo state.

**Sub-agent synthesis (extra context the audit didn't have):**
The repo **still exposes** these entrypoints aggressively: `package.json` maps multiple `npm run pmci:*` scripts onto `scripts/review/*`, `pmci:auto-link` → `scripts/ops/pmci-auto-link-pass.mjs`, classify scripts under `scripts/classify/`, and Supabase-era migrations reference cron-style review pipelines. None of those facts prove weekly execution versus dormant tooling after Phase G closure (ADR-001). Automated crons partially overlap `supabase/functions/pmci-job-runner` job names flagged for future deprecation in Track B — but **whether you still intentionally trigger proposers** is outside git.

**If you trust the audit → answer:** OPERATOR-VERIFY

**If you want to think differently, the relevant tension is:**
Marking scripts “cold” prematurely could strand legitimate sports/politics maintenance while indexer/MM stay live on PMCI primitives.

**Your answer: [x] NO CADENCE — assume not running.** Operator unaware of any cadence; treat Phase G ops scripts as cold. This unblocks `lib/matching/` and bilateral-schema archival in the "Only-after-thesis-validated" tier-3 cleanup bucket (post-7-day-clock).

## Recommended ordering for operator review

1. **Q7 (lovable-ui / MMDashboard scope)** — unblocks frontend cleanup semantics and avoids shipping Track B deletes that contradict product intent.

2. **Q8 (Phase G script cadence)** — structural gate for archiving `lib/matching/` safely; postpone until thesis exit if still occasionally run.

3. **Q5 (CLAUDE invariant)** — tighten control-plane posture before any automation around MM admin actions expands.

4. **Q1 (`costs.mjs` wording vs code)** — low risk; aligns documentation and Contract R7 references with implemented `pnl-attribution`.

5. **Q2 (snapshot-recovery narrative)** — same class as Q1: remove misleading indexer coupling in MM plan prose.

6. **Q6 (`last_snapshot_at`)** — already resolved in migrations; skim and check off.

7. **Q3 (`v_polymarket_latest_prices`)** — already resolved observer-side in migration; skim and check off.

8. **Q4 (`/health/mm` placement)** — already resolved by runtime Fastify wiring; skim and check off — useful if you revisit API topology documentation.
