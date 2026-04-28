# Decision Log

## 2026-02-26 — Infrastructure-first execution
- Prioritized data integrity + ingestion reliability over feature expansion.
- Adopted autonomous discovery for repo + runtime context before block.

## 2026-02-26 — SLO health surface
- Added `/v1/health/slo` and in-process request/DB latency metrics.
- Rationale: make reliability measurable before monetization optimization.

## 2026-03-04 — Deprecate root api.mjs in favor of src/api.mjs
- Decision: treat root `api.mjs` as legacy; active PMCI HTTP API is `src/api.mjs` (Fastify).
- Root `api.mjs` remains for execution-intelligence endpoints only; no new PMCI routes there. Sunset milestone TBD.
- Documented in `api.mjs` header, `docs/system-state.md` (Legacy vs active runtime surfaces), and this log.

## 2026-03-06 — Single-platform event tracking policy (Option A)
- Decision: track active markets only (no historical/settled ingestion). Events present on only one platform are stored in `provider_markets` as-is, with no cross-platform link.
- When the same event later appears on the second platform, the proposer generates a link proposal and the review loop connects them retroactively.
- Rationale: spread observation requires live prices; settled markets have no pricing signal. Option B (historical catalog) adds DB cost with no immediate value for the observer use case.
- Affects: `ingestPolymarketUniverse` keeps `active=true&closed=false` filter. No schema change needed.

## 2026-03-06 — AGENT_ENHANCER meta-agent architecture
- Decision: add a generic self-correcting meta-agent (`agents/AGENT_ENHANCER.md`) that mines data trails left by any agent after a `/coordinate` session and proposes targeted improvements.
- Rationale: 162 rejected proposals with only 9 accepted (5.5% rate) indicates the proposer generates noise that costs review time. Mining rejection patterns (Pattern E: outcome_name_match=0, Pattern F: date delta >120d) and feeding them back into PROPOSAL_REVIEWER makes the pipeline self-correcting without ML.
- Scope: project-local only (`agents/`, `.claude/commands/`, `docs/decision-log.md`). Approval-gated per proposal. Never modifies src/, scripts/, or migrations.
- Entry point: `/enhance-agents [TARGET_AGENT]` or auto-prompted after Step 6 in `/coordinate`.

## 2026-03-06 — api_p95_latency fix (448ms, was 881ms)
- Root cause: `max(observed_at)` on 405K snapshot rows was 454ms. Existing composite index (provider_market_id, observed_at DESC) can't answer global max efficiently. Freshness endpoint ran 2 expensive queries in series; assertFreshness preHandler hit this on every /v1/signals/* call; /v1/health/slo triggered it twice.
- Fix 1 (DB): Added `idx_pmci_snapshots_observed_at_desc` — global max now ~62ms (index-only scan)
- Fix 2 (DB): Added `idx_pmci_provider_markets_provider_id` — provider_id lookups faster
- Fix 3 (code, server.mjs): 5-second in-process freshness lag cache (`getCachedLag`) — eliminates repeated DB hits for assertFreshness within a request burst
- Fix 4 (code, health.mjs): Replaced `GROUP BY p.code` JOIN query with faster `GROUP BY pm.provider_id` subquery — provider latest join: 303ms → 160ms
- Result: freshness 904ms→261ms, SLO 881ms→399ms, top-divergences 2,286ms→58ms, p95 448ms ✓
- Migration: `supabase/migrations/20260306120001_pmci_snapshot_latency_indexes.sql`

## 2026-03-06 — Politics normalization: confirmed Kalshi×Polymarket overlap is narrow
- Proposer ran against all 2,814 provider_markets. 28,508 pairs evaluated. 0 proposals generated — all below 0.88 confidence threshold.
- Best pair found: 0.86 (cross-geography noise — Toronto mayor vs LA mayor). Top legitimate category (pres_nominee_us_2028): best confidence 0.81.
- Conclusion: genuine high-confidence cross-platform overlap in active US politics is concentrated in 2028 presidential nominees. TX/NC/Iran/Venezuela/shutdown events are single-platform by nature for now (Kalshi does not currently list equivalent active markets).
- Decision: accept current state (138 links, 2/22 canonical events), apply Option A (single-platform tracking), move toward Phase E planning.

## 2026-04-01 — Phase E1 sports ingestion: category filter over ticker prefix
- Decision: filter Kalshi sports series by `series.category === 'Sports'` rather than ticker prefix matching.
- Rationale: Kalshi tickers are KX-prefixed (e.g. `KXNFLWINS-ATL`). Start-of-string prefix matching against `NFL`, `NBA`, etc. silently rejects everything. Category field is the reliable signal. API returns all 9306 series in one shot with `limit=10000` — no cursor pagination needed.
- Also: Kalshi market status is `'active'` not `'open'`; fixed filter to accept `['active', 'open']`.
- Affects: `lib/ingestion/sports-universe.mjs`

## 2026-04-01 — Sport inference uses series title, not ticker
- Decision: pass human-readable series title to `inferSportFromKalshiTicker()`, not the KX-prefixed ticker string.
- Rationale: titles like "Pro football exact wins SF" are more reliable than `KXNFLWINS-SF`. Patterns changed from `^NFL` (start-of-string) to `\bNFL\b` (word-boundary anywhere) so they work on both titles and tickers.
- Affects: `lib/ingestion/services/sport-inference.mjs`

## 2026-04-01 — Polymarket sports: dynamic tag discovery over hardcoded slugs
- Decision: fetch all Polymarket tags with pagination and keyword-match against sport patterns rather than hardcoding slugs like `"nfl"`, `"nba"`.
- Rationale: Polymarket's tags are event-specific (e.g. `madrid-open`, `nba-playoffs-2026`, `connor-mcdavid`). Hardcoded slugs miss nearly all sports markets. Dynamic discovery via regex against tag labels/slugs captures the full sports surface area.
- Affects: `lib/ingestion/sports-universe.mjs` (`fetchPolymarketSportsTags`)

## 2026-03-06 — Roadmap updated to include Phase D, E, F
- Decision: formally document the expansion roadmap beyond Phase C.
- Phase D: complete politics normalization (cross-platform links for all active political events).
- Phase E: sports + crypto (requires Phase D complete — different market structure, rapid event turnover for sports, continuous price events for crypto).
- Phase F: additional providers (Metaculus, Manifold, PredictIt) — after normalization loop battle-tested across 3 categories.
- Entry criteria for Phase E: observer running, ≥10/22 canonical events linked, p95 <500ms.

## 2026-04-09 — Live audit becomes documentation source of truth refresh trigger
- Decision: treat live repo audits as the trigger to refresh roadmap/state/supporting docs when implementation reality drifts from documentation.
- Refresh order: `docs/roadmap.md` → `docs/system-state.md` → `docs/decision-log.md` → directly affected phase/validation docs.
- Rationale: the repo had moved beyond older E1/E1.5 documentation, including branch-local sports workflow scripts and bounded E1.5 proposer work, while some docs still described those scripts as missing.
- Constraint: do not promote planning docs into implementation claims; branch-local progress must be labeled as branch-local until verified on the intended baseline.
- Same audit also confirmed that Phase F remains planning-only in code as of 2026-04-09.

## 2026-04-09 — Rerun evidence supersedes earlier same-day snapshot counts
- Decision: update roadmap/system-state E1 evidence using rerun outputs from this audit pass rather than earlier same-day counts.
- Fresh evidence: `npm run pmci:propose:sports` returned `considered=0 inserted=0 rejected=0`; `npm run pmci:audit:sports:packet` produced `semantic_violations=0`, `stale_active=19222`, `unknown_sport=38707`; `npm run pmci:smoke` (18:30 UTC rerun) reported `provider_markets=71750`, `snapshots=415249`, `families=3119`, `current_links=124`.
- Branch status at audit time: `fix/e1-5-sports-proposer-2026-04-08` is ahead of `main` by 2 commits (`52b413f`, `452a784`), so E1.5 conclusions are branch-local until merged.
- Outcome: keep E1.5 as incomplete, keep Phase F as planning-only, and mark older contradictory snapshots as historical context.

## 2026-04-10 — Live roadmap audit refresh after E1.5 merge
- Decision: refresh canonical docs (`roadmap` → `system-state` → `decision-log`) using direct repo/runtime evidence after E1.5 merge.
- Evidence from this run:
  - `git status --short --branch` => local `main...origin/main [ahead 6]` with unrelated workflow-doc edits in working tree.
  - `npm run verify:schema` => PASS.
  - `npm run pmci:smoke` => `provider_markets=76587`, `snapshots=672374`, `families=3120`, `current_links=131`.
  - `find src/routes` and route/source checks confirm no Phase F execution-readiness API surface (`/v1/signals/ranked`, `/v1/router/best-venue`) implemented yet.
- Documentation policy update: preserve earlier count snapshots as historical context, but anchor current-state claims to the latest rerunnable command output.
- Outcome: E1.5 remains complete and merged; Phase E2 remains next; Phase F remains planning-only until code/runtime evidence exists.


## 2026-04-12 — Live roadmap audit refresh (evidence-first)
- Decision: refresh roadmap/state docs from rerunnable repo evidence, keeping older smoke/runtime snapshots explicitly historical.
- Evidence from this run:
  - `git status --short --branch` => local `main...origin/main [ahead 7]` with unrelated workflow/doc/script edits in the working tree.
  - `npm run verify:schema` => PASS.
  - `npm run pmci:smoke` => `provider_markets=80375`, `snapshots=816206`, `families=3120`, `current_links=131`.
  - `find src/routes` + route/service probes confirm no Phase F execution-readiness API/code yet (`/v1/signals/ranked`, `/v1/router/best-venue`, `src/services/tradability-service.mjs`, `config/execution-readiness.json` missing).
- Outcome: E1.5 remains complete and merged; E2 remains the active next milestone; Phase F remains planning-only until direct code/runtime evidence appears.

## 2026-04-12 (late check) — Revalidate live audit docs and diagnose cron false-negative
- Decision: treat the cron status `Apply Patch failed` as a delivery/reporting false-negative for run outcome, because the run summary and repo history confirm docs were refreshed and committed.
- Evidence:
  - Cron run history entry for job `5efe61d2-13b4-45dd-be99-b7ec230e3387` shows `status=error` with `error="⚠️ 🩹 Apply Patch failed"` while the same entry summary reports completed updates and commit `d12828a`.
  - `git log --oneline` confirms `d12828a` exists on `main`, following prior audit commits `ff69db3` and `3dcf4ea`.
  - Late rerun checks: `npm run verify:schema` => PASS; `npm run pmci:smoke` => `provider_markets=80606`, `snapshots=820548`, `families=3120`, `current_links=131`.
  - Phase F execution-readiness probes remain missing (`/v1/signals/ranked`, `/v1/router/best-venue`, `src/services/tradability-service.mjs`, `src/services/router-service.mjs`, `config/execution-readiness.json`).
- Outcome: docs remain directionally correct; refreshed smoke/branch snapshot lines to match late rerun evidence and preserved the cron false-negative diagnosis.

## 2026-04-13 — Live roadmap audit refresh: preserve E1.5 closeout as historical, flag current drift
- Decision: keep 2026-04-10 E1.5 completion as historical truth, but stop presenting it as current strict-audit health after live rerun evidence.
- Evidence from this run:
  - `git status --short --branch` => `main...origin/main [ahead 9]` with unrelated workflow/doc/script edits and untracked files in working tree (no separate feature branch).
  - `npm run verify:schema` => PASS.
  - `npm run pmci:smoke` => `provider_markets=80606`, `snapshots=834102`, `families=3120`, `current_links=131`.
  - `npm run pmci:propose:sports` => `considered=12374090`, `inserted=66`, `rejected=12373696`.
  - `npm run pmci:audit:sports:packet` => `stale_active=8317`, `unknown_sport=1663`, `semantic_violations=369`.
  - Phase F execution-readiness probes still missing in active PMCI API (`/v1/signals/ranked`, `/v1/router/best-venue`, `src/services/tradability-service.mjs`, `src/services/router-service.mjs`, `config/execution-readiness.json`).
- Outcome: roadmap/system-state were refreshed to separate historical closeout from current live state; E2 remains planning-unblocked but not promoted to active implementation claims while E1 strict-audit is red.

---

<!-- ADRs below document the pivot stretch (2026-04-19 — 2026-04-24); see roadmap §2 row 7 / audit Group G2. Vault cross-references: Obsidian `_home.md`/`90-decisions/` mirror planned in §5 cleanup. -->

## ADR-001: Phase G closeout without Lever-D NHL/MLB alias-map expansion — 2026-04-19

**Status:** Accepted

**Decision:** Close Phase G (sports linker bilateral matching) without the Lever-D NHL/MLB alias-map expansion — the linker’s bottleneck was upstream data hygiene and batch composition (duplicate canonical_events, polluted participants, Kalshi-dominated batches where `linked=0` paired with large `attached=1165`-class attachment counts), not a missing pairwise alias layer.

**Context:** Symptoms pointed at the matcher surface, but the hit-rate ceiling traced to duplicated canonical namespaces and labeling noise that the alias map could not amortize away. Investing in Lever D would deepen entanglement with the same degraded inputs rather than reallocating fixes to ingestion and normalization.

**Alternatives considered:**
- **Proceed with Lever D NHL/MLB expansion** — rejected: expected marginal lift versus effort; duplicates/participants dominate miss budget.
- **Extend Phase G timelines indefinitely** — rejected: diminishing returns absent upstream repairs; violates focus on reversible bets.
- **Suspend all linking** — rejected: PMCI linkage remains valuable elsewhere; scope reduction is narrower than abandonment.

**Consequences:**
- Phase G terminates without alias-map rollout; Lever D is not on the backlog for revival on this codebase path (`CLAUDE.md` arb-era constraints).
- Stakeholders treat linker metrics as gated by ingestion quality checks before any future matching investment.
- H2h / linker historical artifacts remain in `docs/archive/pivot-2026-04/` for reference.

**Sources:**
- `docs/plans/phase-g-bilateral-linking-postmortem.md`
- `docs/plans/phase-g-bilateral-linking-strategy.md`
- `docs/archive/pivot-2026-04/pivot/artifacts/linker-bugs-phase-g.md`

## ADR-002: Arb thesis closed RED terminal — 2026-04-24

**Status:** Accepted

**Decision:** Cut losses on the Kalshi+Polymarket arbitrage thesis: the realized-edge backtest is closed **RED**. Do **not** authorize Lever D, classifier finer-bucket subdivision, or repeat A3/A5 rubric cycles to “rescue” the same thesis on this provider pair.

**Context:** The cross-venue arb surface proved structurally shallow — spread of opportunities is thin and unstable — so parameter tuning yields diminishing returns after the dataset has falsified profitability. Pivot review agreed that salvage work would mostly increase operational surface area without credible edge restoration.

**Alternatives considered:**
- **Tune fee/slippage models and rerun A5** — rejected: thesis failure is structural shallow pool, not a single-parameter miss.
- **Expand NHL/MLB alias coverage (Lever D)** — rejected; explicitly superseded per ADR-001 linkage constraints and banned under pivot closeout (`CLAUDE.md`).
- **Continue live arb scaffolding in mainline** — rejected: entangles MM roadmap and violates clean pivot boundary.

**Consequences:**
- `docs/archive/pivot-2026-04/` is the authoritative historical record for arb-era plans, prompts, and artifacts — not a revive queue.
- New trading theses branch from current MM/pivot docs, not dormant arb pipelines.
- Red-team evidence (A3/A5 summaries) informs future provider pairs rather than rerun gates on Kalshi+Polymarket arbitrage alone.

**Sources:**
- `docs/archive/pivot-2026-04/README.md`
- `docs/archive/pivot-2026-04/plans/phase-pivot-arb-and-templates-plan.md`
- `docs/archive/pivot-2026-04/pivot/artifacts/a5-backtest-interpretation-2026-04-24.md`

## ADR-003: MM MVP accepted as successor thesis — 2026-04-24

**Status:** Accepted

**Decision:** Adopt Kalshi-only market making as the MVP successor thesis — fair-value model, inventory-aware quoting, MM-specific backtesting, and adverse-selection tracking — deliberately reusing a bounded slice (~30–40%) of arb-era infrastructure (observer, Kalshi client, portions of costs/resolution).

**Context:** U.S.-resident/legal constraints forbid Polymarket *execution*, but Kalshi quotes are admissible. MM concentrates capital and engineering on one execution venue while still allowing Polymarket-derived *information* (wallet flow) elsewhere as auxiliary signal.

**Alternatives considered:**
- **Retain arb as parallel primary** — rejected: RED terminal (ADR-002) removes funding mandate.
- **Polymarket-first MM** — rejected: violates execution constraint class.
- **Greenfield provider with no infra reuse** — rejected: needless schedule risk; disciplined reuse lowers time-to-quote.

**Consequences:**
- Roadmap sequencing shifts to MM milestones (W1 depth, subsequent MM engine work per `phase-mm-mvp-plan.md`).
- Operational reviews judge progress against Kalshi/MM metrics, not cross-venue arb P&L placeholders.
- Polymarket remains non-execution; any Poly integration is informational only until explicit ADR supersession.

**Sources:**
- `docs/plans/phase-mm-mvp-plan.md`
- `docs/archive/pivot-2026-04/pivot/north-star.md`

## ADR-004: Polymarket wallet indexer (info-source only) — 2026-04-24

**Status:** Accepted

**Decision:** Stand up a Polygon RPC + subgraph-backed Polymarket **wallet** indexer read path — advisory toxicity / wallet-flow signal for MM. No Polymarket account, custody, or trading hooks; outputs are informational features, not mandatory MM exit gates.

**Context:** Poly’s public order-flow is the richest alternative-information surface compatible with execution staying on Kalshi. Read-only ingestion matches compliance posture without duplicating arb-era trade routing.

**Alternatives considered:**
- **Defer all Polymarket integration** — rejected: discards orthogonal signal unrelated to arb execution bans.
- **Polymarket API trading mirror** — rejected: violates non-execution invariant.
- **Make wallet signal load-bearing for MM KPIs day one** — rejected: adds fragility until proven stable; phased advisory use only.

**Consequences:**
- Indexer SLA and schema changes are graded “advisory unless promoted by later ADR.”
- Operators document wallet lag/freshness distinctly from Kalshi quoting paths.
- No wallet code path obtains trading credentials beyond public RPC endpoints.

**Sources:**
- `docs/plans/phase-poly-wallet-indexer-plan.md`

## ADR-005: MM W1 schema/code spec-check corrections — 2026-04-24

**Status:** Accepted

**Decision:** Before committing build capacity, corrected W1 depth modelling to Kalshi truth: relational columns **`yes_levels`** / **`no_levels`** (replacing generic `{bids,asks}`) because both ladders are bids; **`UNIQUE (provider_market_id, observed_at)`** guarantees idempotent re-emission after reconnect/restart without duplicate rows.

**Context:** Earlier prose assumed symmetrical bid/ask ladders; Kalshi WebSocket payloads expose YES-bid and NO-bid ladders, with YES ask implied as **`100 − best_no_bid`**. Persisting mismatched semantics would have produced empty ladders and meaningless mids at read time.

**Alternatives considered:**
- **Keep generic bid/ask naming** — rejected: misleads downstream fair-value maths.
- **Open interval upserts without uniqueness** — rejected: duplicates under reconnect violate analytics and storage budgets.
- **Derive ladders client-side without schema fix** — rejected: persists incorrect invariant in DB contradicting telemetry.

**Consequences:**
- Downstream MM consumers import schema semantics literally from migrations + `depth.mjs`; YES-ask derivation stays centralized at read/filter layers.
- Reconnect-heavy runs cannot duplicate `(provider_market_id, observed_at)` rows unintentionally.

**Sources:**
- `supabase/migrations/20260424120004_pmci_provider_market_depth.sql`
- `lib/ingestion/depth.mjs`

## ADR-006: Do not revive arb-pivot invariant — 2026-04-24

**Status:** Accepted

**Decision:** Encode in-repo (notably `CLAUDE.md`) that Kalshi+Polymarket **arb-pivot code, prompts, grading rubrics, and execution experiments** MUST NOT drift back onto the primary development branch/workstream. `docs/archive/pivot-2026-04/` remains **reference-only**; a materially new provider pairing starts a documented **new pivot**, not a stealth revival fork.

**Context:** Consolidated pivot review surfaced that mixed revival invites schema drift (`arb`/`mm` coexistence ambiguity), brittle operator mental models (“which thesis is authoritative?”), and repeated cleanup cost exceeding salvage value once ADR-002 closed arb RED.

**Alternatives considered:**
- **Cherry-pick arb scripts privately** — rejected: opaque reuse bypasses invariant control.
- **Soft guidelines only (Slack/policy)** — rejected: regressions recur without enforced repo guardrails (`CLAUDE.md` + audits).
- **Delete arb archive** — rejected: loses forensic value; disciplined archive suffices.

**Consequences:**
- PR reviewers reject changes that resurrect arb-era routes, matchers, or rubrics on Kalshi+Poly without explicit new ADRs.
- Automated agents default to archived paths for archaeology, not copy-paste into `lib/` mains.
- Any future arb-like effort names a distinct phase document and KPI set before merging code.

**Sources:**
- `CLAUDE.md` (Invariants; arb pivot closure)
- `docs/archive/pivot-2026-04/README.md`

## ADR-007: MM W2 plan-text contracts (R7/R8/R9/R11) — 2026-04-28

**Status:** Accepted

**Decision:** Treat **Contract R7** (per-market P&L attribution formula), **Contract R8** (`fair_value_at_fill` = place-time semantics), **Contract R9** (`client_order_id` format `mm-<ticker>-<side>-<unix_ms_5s>-<rand4>`), and **Contract R11** (cancel-on-place fire-and-forget sequencing) as **normative** for W2 implementation. They are appended to `docs/plans/phase-mm-mvp-plan.md` as plan-text amendments; code and schema work must conform unless explicitly superseded by a future ADR.

**Context:** With the observer healthy and MM W2 starting, locking these definitions prevents divergent attribution, idempotent order identity, or blocking behavior across `kalshi-trader`, fill logging, and the orchestrator.

**Alternatives considered:**
- **Defer contracts to PR review only** — rejected: unstructured drift between modules.
- **Encode only in code comments** — rejected: obscures PMCI/MM operating truth for operators and agents.

**Consequences:**
- W2 reviewers check PRs against the four subsection contracts in `phase-mm-mvp-plan.md`.
- Backtests and dashboards that consume `mm_fills` / `mm_pnl_snapshots` assume Contract R8 for adverse metrics.

**Sources:**
- `docs/plans/phase-mm-mvp-plan.md` (§ W2.0 plan-text contract amendments)

## ADR-009: Poly indexer W1 schema + reorg state machine + read-only client namespace — 2026-04-28

**Status:** Accepted

**Decision:** Ship **Pre-Poly-W1 P1** (read-only `lib/poly-indexer/clients/` + CI `lint:poly-write-guard` banning non-whitelisted HTTP stacks against `clob.polymarket.com` / Polymarket trading API paths), **Pre-Poly-W1 P2** (pure `lib/poly-indexer/reorg.mjs` fork-choice + final-row panic), and **Poly W1** database objects: `pmci.poly_wallet_trades` (RANGE `block_number` + initial catch-all partition), `pmci.poly_market_flow_5m` (5m buckets + RANGE `bucket_start` partitions), `pmci.poly_indexer_cursor` (head vs final watermarks), `pmci.poly_resolved_markets`, all with **anon/authenticated REVOKE** and **service_role/postgres GRANT** consistent with Pre-W2 §3. **Confirmation depth** defaults to **64 blocks** for marking `final=true` (audit §3 P2); indexer **process** lands in W2 (`pmci-poly-indexer` Fly app), not W1.

**Context:** Post-pivot roadmap calls for Polymarket on-chain data as an **information-only** source (US-resident posture: no trading paths, no Polymarket accounts). W1 confines work to **library + schema + tests** so workstream B (MM depth) stays file-disjoint.

**Alternatives considered:**
- **Single watermark cursor** — rejected: cannot both tail near-head and treat post-confirmation rows as immutable without split `head_*` / `final_*`.
- **Defer P1 CI guard** — rejected: posture must be enforced in CI, not prose only.
- **Unpartitioned trade table** — rejected: audit §4 W2 schema-fitness requires RANGE partitioning from day one.

**Consequences:**
- New RPC/subgraph **read** code must live under `lib/poly-indexer/clients/` (or earn an explicit allowlist entry in `scripts/lint/no-polymarket-write.mjs` with owner review).
- `verify:schema` includes the four `poly_*` tables once the migration is applied.
- **ADR-008** remains reserved for workstream D’s 7-day continuous test clock (do not renumber).

**Sources:**
- `audits/post-pivot-review/synthesis/post-pivot-roadmap.md` (§3 Pre-Poly-W1, §4 Poly W1)
- `supabase/migrations/20260430130000_pmci_poly_w1.sql`
- `lib/poly-indexer/clients/`, `lib/poly-indexer/reorg.mjs`, `scripts/lint/no-polymarket-write.mjs`

## 2026-04-28 — Pre-existing test debt — accepted for Pre-W2 deploy

- **Context:** Before merging `pre-w2/integration` → `main`, `npm test` was compared on `origin/main` vs `pre-w2/integration`. The same two failures appear on **main** (not introduced by Pre-W2).
- **Accepted debt (do not block Pre-W2 Fly deploy):**
  1. **`test/backtest/leg-payout.test.mjs` — "A3 csv parses to table rows (quoted newlines) and default path exists"** — `ENOENT` opening `docs/pivot/artifacts/a3-resolution-equivalence-audit.csv` (artifact absent from repo; pivot reference path).
  2. **`test/routes/review.test.mjs` — "POST /v1/review/decision accept: succeeds on first call (happy path)"** — assertion `null !== 10` (expected `proposed_id` from DB/fixture; behavior vs test data mismatch).
- **Rationale:** Ship Pre-W2 API/observer fixes (health endpoints vs live schema) while tracking test repair separately.

