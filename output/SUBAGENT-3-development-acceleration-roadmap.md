# Subagent 3 — Development acceleration roadmap

**Repo:** `prediction-machine` (worktree `lby`). **Goal:** Shorter iteration loops, safer parallel agents, faster new verticals (crypto, economics).

---

## 30 / 60 / 90 days

### 30 days — Prove green + split blast radius

- Add **`npm test`** wiring to `node --test` over `test/**/*.test.mjs` (today `package.json` has many scripts but **no** `test` entry — agents lack a standard verify step).
- Composite **`npm run verify`** (or `ci:local`): unit tests + existing `npm run verify:schema` (`scripts/validation/verify-pmci-schema.mjs`).
- **Profile split:** extract config-only `profiles/politics.mjs`, `profiles/sports.mjs` from `lib/ingestion/universe.mjs` + `lib/ingestion/sports-universe.mjs` so two agents rarely touch the same 800-line file.
- **Contract smoke:** optional script diffing `docs/openapi.yaml` vs route registrations under `src/routes/` (start with manual checklist if automation is heavy).
- **Ops triplet as default:** `pmci:smoke`, `pmci:probe`, `pmci:watch` + document env next to `src/platform/config-schema.mjs`.

### 60 days — Adapters + vertical slices

- Formalize **source adapter** surface already emerging in `lib/providers/kalshi-adapter.mjs`, `polymarket-adapter.mjs`: normalized price maps + structured errors; call from `lib/ingestion/observer-cycle.mjs` patterns only.
- **Normalization = pure functions** under `lib/ingestion/services/` (`market-metadata.mjs`, `sport-inference.mjs`, `price-parsers.mjs`); add `crypto-inference.mjs` / `economics-inference.mjs` with tests in `test/ingestion/`.
- **Matching surface:** `lib/pmci-matching-adapters.mjs` + `lib/matching/proposal-engine.mjs` as the only supported entry for proposals; extend `test/fixtures/matching/` before engine changes.
- Keep **`intelligence-feed.mjs`** observation-only; do not mix execution/trading experiments into ingestion PRs.

### 90 days — Multi-vertical production

- Mirror the **script quartet** per vertical: `scripts/discovery/*`, `scripts/ingestion/*`, `scripts/review/*`, `scripts/seed/*` (copy politics + sports layout).
- **Retention / cost:** snapshot policy already in migrations — add per-`category` knobs if crypto tick volume demands it.
- **API negotiation:** `docs/openapi.yaml` + `docs/api-reference.md` vs `src/routes/*` for any consumer (e.g. `lovable-ui`).
- **Agent task packets:** extend `agents/README.md` with allowed paths per role to reduce merge conflicts.

---

## Module boundaries (recommended)

| Layer | Owns | Primary paths |
|-------|------|----------------|
| **Source adapters** | HTTP, auth, retries, venue quirks | `lib/providers/kalshi.mjs`, `polymarket.mjs`, `*-adapter.mjs` |
| **Normalization** | Title/metadata → typed fields; **no** DB | `lib/ingestion/services/*` |
| **Persistence orchestration** | Upserts, snapshots, heartbeats | `lib/pmci-ingestion.mjs`, `src/platform/db.mjs` |
| **Matching** | Features, guards, proposals | `lib/matching/*`, `lib/pmci-matching-adapters.mjs` |
| **Execution / signals** | Read models, freshness, downstream consumers | `src/routes/signals.mjs`, `intelligence-feed.mjs`, SQL views in `supabase/migrations/` |

---

## Cursor / multi-agent practices (repo-specific)

1. Anchor prompts with `docs/architecture.md`, `docs/system-state.md`, `docs/api-reference.md` (per `agents/README.md`).
2. **One agent = one subtree:** e.g. A → `lib/ingestion/` + `scripts/ingestion/`; B → `lib/matching/` + `scripts/review/`; C → `src/routes/` + `test/routes/`.
3. Prefer **`src/api.mjs`** / `src/server.mjs` for API; treat root `api.mjs` as legacy (`docs/architecture.md`).
4. **Fixtures before engine:** matching changes start in `test/fixtures/matching/` + `test/matching/*.test.mjs`.
5. Declare **env subsystem** (`src/platform/env.mjs` vs API `config-schema.mjs`) in task specs to avoid wrong-debugging.

---

## Engineering investments (priority)

1. `npm test` + aggregate verify — unblocks honest agent completion.
2. Universe profile split — reduces merge conflicts and session length.
3. Shared HTTP helper for all universe scripts — single retry/timeout story.
4. OpenAPI vs routes parity — prevents silent contract drift.
5. Category health scripts — clone `scripts/checks/health-politics-snapshot.mjs` pattern.
6. Embedding cost/latency gates — tied to bulk ingest (`lib/pmci-ingestion.mjs`).

---

## Next 5 commits (suggested)

1. `package.json`: add `"test": "node --test test/**/*.test.mjs"` (adjust glob to match layout).
2. Add `"verify:local": "npm test && npm run verify:schema"` (name as you prefer).
3. Thin `scripts/ingestion/pmci-smoke-sports.mjs` (or flag on existing smoke) if DB supports category filter.
4. Extract shared `fetchGamma` / `fetchWithTimeout` usage from `sports-universe.mjs` only (no matching changes).
5. One new matching fixture + test locking a future crypto/economics title shape.

---

## Key path index

| Area | Path |
|------|------|
| Observer | `observer.mjs`, `lib/ingestion/observer-cycle.mjs` |
| Politics bulk | `lib/ingestion/universe.mjs`, `scripts/ingestion/pmci-ingest-politics-universe.mjs` |
| Sports bulk | `lib/ingestion/sports-universe.mjs` |
| PMCI writes | `lib/pmci-ingestion.mjs` |
| Matching | `lib/matching/proposal-engine.mjs`, `lib/matching/sports-helpers.mjs` |
| API | `src/api.mjs`, `src/server.mjs`, `src/routes/` |
| Contracts | `docs/openapi.yaml`, `docs/contracts.md`, `docs/api-reference.md` |
| Tests / fixtures | `test/`, `test/fixtures/matching/` |

---

*Generated 2026-04-13 — opinionated plan; adjust dates to your release cadence.*
