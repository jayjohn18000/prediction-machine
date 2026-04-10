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
