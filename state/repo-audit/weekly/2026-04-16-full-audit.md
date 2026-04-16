# PMCI Live Roadmap Audit — 2026-04-16

_Generated: 2026-04-16T16:08:37.305Z (UTC) · `auditMode=docs_only`_

## Summary

- **Git:** `main` @ `3df03b154f3f`
- **Roadmap milestone (repo):** Current milestone: E2 ∥ E3 — Crypto + Economics/macro (starting 2026-04-14)
- **Open E2 checklist items:** 3 | **Open E3 checklist items:** 2
- **Wiki:** read allowlisted files (_home.md, 80-phases/_index.md, 90-decisions/_index.md)

## Evidence-first findings

- **DB gates:** SKIPPED — set `AUDIT_REPO_SKIP_DB=1`; no `verify:schema` / `pmci:smoke` / `pmci:probe` run.
- `git status -sb` (first line): `## main...origin/main`
- **PMCI_WIKI_ROOT:** `/Users/jaylenjohnson/Documents/Claude/Projects/Prediction Machine` — files: _home.md, 80-phases/_index.md, 90-decisions/_index.md

## Drift notes

- Compare wiki `last-verified` / active-phase lines with `docs/roadmap.md` **Current milestone** and `docs/system-state.md` carry-forward.
- If this run used `AUDIT_REPO_SKIP_DB=1`, re-run weekly without it for live DB evidence.

## Open checklist (E2 / E3) from docs/roadmap.md

### E2
  - [ ] Define crypto canonical event schema (price-based, continuous, non-binary templates)
  - [ ] Adapt spread computation for non-binary / ladder markets where YES/NO mid is insufficient
  - [ ] Strict-audit packet + semantic gates at acceptance (same pattern as sports)

### E3
  - [ ] Dedicated semantic guards (resolution timing, Fed meeting ids, outcome labels) + audit packet
  - [ ] Expand Kalshi series / Polymarket tag coverage from competitive benchmarks

## Roadmap excerpt (repo, truncated)

```
# Roadmap (Infrastructure-First → Normalization → Expansion)

## Phase A — Baseline Stability ✓ complete
- [x] Schema validation gate
- [x] Smoke checks + coverage checks
- [x] SLO health endpoint (`/v1/health/slo`)
- [x] Bootstrap CLI + `/v1/health/projection-ready`

## Phase B — Reliability Hardening ✓ complete
- [x] Observer heartbeat table (`pmci.observer_heartbeats`)
- [x] Error taxonomy: kalshi/poly fetch, spread insert, PMCI ingestion, JSON parse
- [x] Real `ingestion_success` SLO backed by heartbeat rolling rate
- [x] `GET /v1/health/observer` endpoint
- [x] Freshness SLA enforcement: `/v1/signals/*` return 503 when stale
- [x] `PMCI_API_KEY` gate on non-health read endpoints
- [x] `.env.example` documents all `PMCI_*` vars

## Phase C — M2M API Readiness ✓ complete (infrastructure)
- [x] Fix pairsAttempted denominator — true_success_rate backed by pairs_configured
- [x] Rate limiting: @fastify/rate-limit, per-key, configurable via env
- [x] TLS: Caddy reverse proxy config, auto-HTTPS via Let's Encrypt
- [x] /v1/review/* auth-gated, review CLI sends x-pmci-api-key
- [x] X-PMCI-Version response header + api_version in health response bodies
- [x] Per-endpoint request logging (pmci.request_log) + /v1/health/usage endpoint
- [x] Stable API contracts documented (OpenAPI or equivalent) — `docs/openapi.yaml` + `docs/api-reference.md`
- [x] Client SDK / integration guide — `lib/pmci-client.mjs` + `docs/integration-guide.md`
- [x] **api_p95_latency < 500ms** — validated 2026-03-17 at **124ms p95** (`/v1/health/slo`, sample_size=129)

## Phase D — Politics Normalization ✓ PHASE COMPLETE
**Goal:** Every active political event on Kalshi or Polymarket is tracked, and every event present on both platforms has an accepted cross-platform market link.

**Closeout (2026-03-13):**
- Semantic remediation complete; residual invalid active gov/pres links = 0.
- Legacy cleanup applied: 12 families / 37 rows deactivated (`status='removed'`).
- Final rates used for closeout: governor 0.067, president 0.636, senate 0.542.

**Acceptance criteria met:**
- Semantic integrity checks pass with zero residual violations.
- Strict audit packet generation passes.
- Guard logic in proposer prevents recurrence of known invalid classes.

### D Follow-on Backlog (non-blocking carryover)
- Governor D6 coverage threshold uplift (0.067 → target ≥ 0.20)
- Full-universe proposer reruns for additional coverage lift
- Observer continuity and freshness improvements
- API p95 optimization (<500ms target)

**Migration path to Phase E (sports/crypto):**
- Use same guard-first proposer + strict-audit gate loop.
- Start with limited category slices and expand only when semantic drift remains zero.

---

## Phase E — Parallel expansion (Sports complete; E2 crypto ∥ E3 economics active)
**Entry criteria:** Phase D semantic closeout complete (met). Coverage/performance targets continue as tracked optimization work during Phase E onboarding.

**Parallel workstreams (same guard-first + strict-audit pattern):**
| Track | Focus | npm scripts (ingest / propose) |
|-------|--------|-------------------------------|
| **E2 — Crypto** | BTC/ETH/SOL cross-venue, binary spread v1 + canonical schema for harder templates | `pmci:ingest:crypto`, `pmci:propose:crypto` |
| **E3 — Economics / macro** | Fed/CPI/rates-style binary macro | `pmci:ingest:economics`, `pmci:propose:economics` |

**Shared exit criteria (per track):** `npm run verify:schema` PASS, `npm run pmci:smoke` PASS, audit packet at 

… (truncated)
```

## System state (repo, excerpt)

```
# System State

## Legacy vs active runtime surfaces
- **Active PMCI API:** `src/api.mjs` (Fastify). Run with `npm run api:pmci` (or `npm run api:pmci:dev`). Serves `/v1/health/*`, `/v1/coverage*`, `/v1/markets/*`, `/v1/market-families`, `/v1/market-links`, `/v1/signals/*`, `/v1/review/*`, `/v1/resolve/link`.
- **Legacy API:** Root `api.mjs` (Node HTTP). Run with `npm run api` (or `npm run api:dev`). Execution-intelligence endpoints only (`/signals/top`, `/execution-decision`, `/routing-decisions/top`). Deprecated in favor of `src/api.mjs` for PMCI; this file is retained for execution-signal use until a sunset milestone. Do not add new PMCI routes here.

## Observer frontier (v2) — env reference
DB-backed pair discovery replaces mandatory large static JSON when enabled.

| Env | Meaning |
|-----|---------|
| `OBSERVER_DB_DISCOVERY=1` | Each cycle, merge capped SQL frontier from `pmci.market_links` (`lib/ingestion/observer-frontier.mjs`) |
| `OBSERVER_USE_DB_FRONTIER_ONLY=1` | Ignore static file; pairs = DB frontier only (still requires `OBSERVER_DB_DISCOVERY=1` behavior) |
| `OBSERVER_ALLOW_EMPTY_STATIC=1` | Allow `[]` in `scripts/prediction_market_event_pairs.json` when using DB merge |
| `OBSERVER_MAX_PAIRS_PER_CYCLE` | Cap DB rows per cycle (default 500) |
| `OBSERVER_CATEGORY_ALLOWLIST` | Optional comma list; both Kalshi and Poly `provider_markets.category` must match |
| `OBSERVER_INCLUDE_PROXY_LINKS=1` | Include `proxy` links in frontier (default: `equivalent` only) |
| `PMCI_SWEEP_PRIORITIZE_LINKED=1` | PMCI sweep orders stale markets so linked `provider_markets` refresh first (`lib/ingestion/pmci-sweep.mjs`) |

## Script ownership boundaries
- `api:pmci*` scripts own PMCI `/v1/*` runtime behavior.
- `api*` scripts (without `:pmci`) are legacy execution API only.
- `start` / `observe:spreads` own observer ingestion loop execution.
- `pmci:*` scripts are PMCI operational workflows (ingest/probe/smoke/review/audit/check), not API server entrypoints.

## Branch
- **Active branch:** `main` at `038715c` — fully synced with `origin/main` (no unmerged branches)
- **Active phase:** **E2 — Crypto ∥ E3 — Economics** (scaffolds committed; guard-first proposer + strict-audit gates not yet run)
- **E1.6 validation audit (2026-04-14):** All exit criteria met. E2/E3 unblocked.
- **Post-E1.6 commits on main (2026-04-14 — 2026-04-15):**
  - `8db2b41` feat(E2/E3): parallel crypto + economics tracks — observer frontier v2, cron parity, Phase F entry gates
  - `1aa1fb7

… (truncated)
```

## Wiki excerpts (allowlisted heads)

### _home.md

```
---
title: PMCI Brain — Home
tags: [meta, home]
status: current
last-verified: 2026-04-15
sources: []
---

# PMCI Brain

Welcome. This is the Prediction Machine project's compiled wiki — a Karpathy-style LLM wiki that synthesizes the project's knowledge into linked markdown pages so agents can read pre-compiled context instead of re-deriving it every session.

**Active phase:** Phase E2 (Crypto) ∥ E3 (Economics) — scaffolds committed 2026-04-15, guard-first runs pending.
**Last full vault build:** 2026-04-15.

## Start here

- New to the project? Read [[system-overview]]
- Working on the database? Start at [[20-database/_index|Database index]]
- Working on the API? Start at [[50-api/_index|API index]]
- Operating in production? Start at [[95-runbooks/_index|Runbooks index]]
- Need vault rules? Read [[vault-conventions]]

## Sections

| Section | What's there | Index |
|---------|--------------|-------|
| 10 — Architecture | System design, component roles, data flow | [[10-architecture/system-overview\|System Overview]] |
| 20 — Database | Supabase schema, one page per table | [[20-database/_index\|Database]] |
| 30 — Providers | Kalshi and Polymarket reference | [[30-providers/_index\|Providers]] |
| 40 — Pipelines | Ingestion, observer, matching, sweep | [[40-pipelines/_index\|Pipelines]] |
| 50 — API | PMCI route reference | [[50-api/_index\|API]] |
| 60 — Frontend | lovable-ui inventory | [[60-frontend/_index\|Frontend]] |
| 70 — Agents | One page per agent spec | [[70-agents/_index\|Agents]] |
| 80 — Phases | Roadmap by phase | [[80-phases/_index\|Phases]] |
| 90 — Decisions | Architectural decision records | [[90-decisions/_index\|Decisions]] |
| 95 — Runbooks | Operational procedures | [[95-runbooks/_index\|Runbooks]] |
| 99 — Sources | Immutable source snapshots | (do not edit) |

## Active milestone

**Phase E2 (Crypto) ∥ Phase E3 (Economics)** — both scaffolded on `main` (commit `8db2b41`).

- E1.6 sports validation: ✅ complete (2026-04-14), 234 sports mark
```

### 80-phases/_index.md

```
---
title: Phases — Index
tags: [phases, index]
status: current
last-verified: 2026-04-15
sources:
  - "[[roadmap-snapshot]]"
  - "[[system-state-snapshot]]"
---

# Phases

Roadmap by phase. Source of truth: [[roadmap-snapshot]].

## Status (2026-04-15)

| Phase | Status | Page |
|-------|--------|------|
| C — politics normalization | ✅ Complete | (historical, see roadmap-snapshot) |
| D — politics extension | ✅ Complete | (historical) |
| E1 — sports universe | ✅ Complete | [[e1-sports]] |
| E1.5 — sport inference + runtime | ✅ Complete (2026-04-10, merged) | [[e1.5-sport-inference]] |
| E1.6 — sports execution-readiness | ✅ Validated 2026-04-14 | [[e1.6-sports-execution-readiness]] |
| **E2 — crypto** | 🟡 Scaffold committed `8db2b41` (2026-04-15), guard-first run pending | [[e2-crypto]] |
| **E3 — economics** | 🟡 Scaffold committed `8db2b41` (2026-04-15), guard-first run pending | [[e3-economics]] |
| F — entry gates / execution-readiness | 📋 Planning only | [[f-entry-gates]] |

## Cross-cutting

- [[roadmap-canonical]] — canonical roadmap reference
- [[guard-first-loop]] — the strict-audit gate pattern reused across categories

```

### 90-decisions/_index.md

```
---
title: Decisions — Index (ADRs)
tags: [decisions, index]
status: current
last-verified: 2026-04-15
sources:
  - "[[decision-log-snapshot]]"
---

# Decisions

One page per architectural decision. Source of truth: [[decision-log-snapshot]].

## Active

- [[infrastructure-first-execution]] — 2026-02-26
- [[slo-health-surface]] — 2026-02-26
- [[deprecate-root-api-mjs]] — 2026-03-04
- [[single-platform-tracking-policy]] — 2026-03-06 (Option A)
- [[agent-enhancer-meta-architecture]] — 2026-03-06
- [[api-p95-latency-fix]] — 2026-03-06
- [[politics-narrow-overlap]] — 2026-03-06
- [[sports-category-filter]] — 2026-04-01
- [[sport-inference-uses-title]] — 2026-04-01
- [[polymarket-dynamic-tag-discovery]] — 2026-04-01
- [[roadmap-phases-d-e-f]] — 2026-03-06
- [[live-audit-refresh-trigger]] — 2026-04-09
- [[rerun-evidence-supersedes-snapshots]] — 2026-04-09
- [[fly-io-deployment-decision]] — 2026-03 (deployment + cron)
- [[observer-frontier-v2]] — DB-backed pair discovery

```

## Probe output (truncated)

```
(skipped — docs-only mode)
```

## Next moves

1. Reconcile wiki vs `docs/roadmap.md` / `docs/system-state.md` when labels diverge.
2. Clear failing gates (`verify:schema`, `pmci:smoke`, `pmci:probe`) before phase work.
3. Burn down open E2/E3 checklist items; update wiki `last-verified` after doc changes.
