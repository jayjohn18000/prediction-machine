# Consolidated audit — ingestion, coverage, velocity (2026-04-13)

**Scope:** Production-style review of the PMCI / ingestion stack in worktree `lby` (same tree as Cursor workspace), plus external API semantics for coverage gaps.

**Output location:** Reports live under `output/` in this worktree (Cursor could not write to `/Users/jaylenjohnson/prediction-machine/output/` from the sandbox). Copy to your canonical repo with:

`cp -R output/*.md /Users/jaylenjohnson/prediction-machine/output/`  
(or merge into `docs/reports/` as you prefer).

**Related files:**

- `output/SUBAGENT-1-repo-blocker-audit.md`
- `output/SUBAGENT-2-external-market-coverage-audit.md`
- `output/SUBAGENT-3-development-acceleration-roadmap.md`

---

## Executive summary

Execution is blocked primarily by **(a)** sports-scale ingest reliability and latency, **(b)** post-ingest snapshot refresh excluding many live rows (`active` vs `open` in sweep SQL), **(c)** embedding work in the hot path for bulk upserts, and **(d)** matching/proposal machinery still centered on politics while sports depends on parallel scripts. External arb APIs appear broader because they paginate fully, search globally, and match fuzzily—your code has explicit caps, narrower discovery, and stricter normalization.

---

## Ranked blockers (all workstreams)

| Rank | Blocker | Workstream | Primary evidence |
|------|---------|------------|------------------|
| 1 | PMCI sweep ignores `status = 'active'` | Repo | `lib/ingestion/pmci-sweep.mjs` `SQL_STALE_MARKETS`; sports writes `active` in `lib/ingestion/sports-universe.mjs` |
| 2 | Embeddings on every `ingestProviderMarket` | Repo | `lib/pmci-ingestion.mjs` → `ensureTitleEmbedding` |
| 3 | Sports universe: sequential ingest + sleeps + hard pagination caps | Repo | `lib/ingestion/sports-universe.mjs` |
| 4 | Sports Gamma fetch: no timeout/retry vs provider modules | Repo | `fetchJson` in `sports-universe.mjs` vs `lib/retry.mjs` in providers |
| 5 | `fetchKalshiWithRetry` failover bug on last attempt | Repo | `lib/ingestion/sports-universe.mjs` ~114 |
| 6 | Narrow discovery vs arb APIs (pagination + filters + search) | External | [Kalshi Get Markets](https://docs.kalshi.com/api-reference/market/get-markets), [Polymarket List events](https://docs.polymarket.com/api-reference/events/list-events), repo caps |
| 7 | `proposal-engine` politics-only constant | Repo | `lib/matching/proposal-engine.mjs` `CATEGORY = 'politics'` |
| 8 | Brittle Polymarket outcome mapping in observer provider | Repo | `lib/providers/polymarket.mjs` |
| 9 | No `npm test` script / weak ingestion test matrix | Velocity | `package.json` |
| 10 | Monolithic universe files → merge conflicts for parallel agents | Velocity | `universe.mjs`, `sports-universe.mjs` |

---

## Recommended execution plan — next 7 days

**Day 1–2 — Unblock snapshots**

- Ship sweep SQL change (or status normalization) so `active` rows receive sweep snapshots; run `pmci:smoke` + `pmci:probe` after deploy.
- Add a one-line metric/log: count of provider_markets by `status` before/after.

**Day 2–3 — Cut bulk ingest latency**

- Env-gate or defer `ensureTitleEmbedding` for `pmci:ingest:sports` / politics universe paths; confirm `OPENAI_API_KEY` off path in staging if embeddings not required for matching in that environment.

**Day 3–4 — Sports HTTP hardening**

- Replace bare `fetchJson` in sports Gamma paths with `fetchWithTimeout` + `retry`; fix `fetchKalshiWithRetry` to try both Kalshi bases on the final attempt.

**Day 5 — Coverage sanity**

- Run the checklist in `SUBAGENT-2` against staging: full cursor walks, compare counts to a small sample from an arb API or manual Gamma search.

**Day 6–7 — Velocity**

- Add `npm test` + `verify:local`; open a follow-up ticket to split universe “profiles” without changing behavior.

**Design decision (if you must choose one):** Prefer **canonicalizing `status` in the DB** (single live enum) over expanding SQL everywhere—less drift long-term—but the sweep-only change is the smallest safe unblock if constraints forbid migrations this week.

---

## Assumptions & gaps

- **Assumed:** Execution layer reads snapshots/views that assume recent `provider_market_snapshots` for linked markets; stale snapshots look like “no arb” even when venues trade.
- **Gap:** Kalshi **response** `market.status` values vs official **query** filter enum (`open`, `closed`, …) were not validated against live JSON in this audit—confirm with a captured payload if `active` appears only in your normalization layer.
- **Gap:** `parallel-cli` unavailable; external section uses official docs + repo cross-check only.

---

## Subagent spawn note

Three tracks were executed: two read-only codebase explorations (ingestion blockers + roadmap) and one external API / mismatch analysis. No overlapping file edits were made; deliverables are markdown under `output/`.

---

*End of consolidated summary.*
