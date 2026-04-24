# MM MVP — W1 Session Kickoff Prompt

> Paste the bolded section below into a fresh Claude Code or Claude Cowork session in the `prediction-machine` repo to start Week 1 of the Market Making MVP. Delete the paragraph above the first `---` before pasting if you want to keep the prompt tight.

---

**Context:** I'm starting Week 1 of the Market Making MVP. The arb pivot closed RED on 2026-04-24; the successor thesis is market making on Kalshi with Polymarket as an on-chain information source. Full context lives in these three files, read them first:

1. `CLAUDE.md` — repo instructions, current phase, invariants
2. `docs/plans/phase-mm-mvp-plan.md` — full MM MVP architecture, components, schema, 6-week build sequence
3. `docs/plans/phase-poly-wallet-indexer-plan.md` — parallel workstream (information-source layer); not W1 scope but worth skimming so W1 schema choices don't conflict

**Week 1 scope (this session):**

Ship depth ingestion and its Supabase schema. At the end of this session we want:

1. A migration that creates the `pmci.provider_market_depth` table per the schema in `phase-mm-mvp-plan.md`.
2. A new module `lib/ingestion/depth.mjs` that:
   - Connects to Kalshi WebSocket at `wss://demo-api.kalshi.co/trade-api/v2/ws` (demo environment — not production yet)
   - Subscribes to `orderbook_snapshot` and `orderbook_delta` channels for a hand-picked 5-market universe (market tickers TBD — pick from `provider_markets` where `category IN ('sports','politics','crypto','economics')` and `status='active'`; skip flagship markets like 2028 presidential or Super Bowl winner)
   - Maintains a local L2 book per market using snapshots + deltas
   - Downsamples to 1-second snapshots and writes to `pmci.provider_market_depth`
3. A Fly deployment config `deploy/fly.mm-depth.toml` (or fold into the observer app if simpler — propose with justification)
4. Tests in `tests/ingestion/depth.test.mjs` covering: snapshot parsing, delta application, downsample correctness, idempotent insert on duplicate timestamps
5. Doc update: add a short section to `docs/system-state.md` describing the depth ingestion dependency

**Hard constraints:**

- Use the demo environment only (`demo-api.kalshi.co`), not production. Separate API keys needed — check `.env.example` for conventions and print a `.env` diff for me to apply manually; do not auto-write to `.env`.
- Write-side Kalshi client (`lib/providers/kalshi-trader.mjs`) is W2, not W1. Don't build it this session.
- Fair-value engine and quoting engine are W3. Don't build them this session.
- Follow existing patterns: ES modules, `.mjs`, Supabase migrations in `supabase/migrations/`, observer-cycle style for the runtime loop if not using a dedicated Fly app.
- Before claiming done, run `npm run verify:schema` (per the CLAUDE.md invariant) and paste the output.

**Explicitly out of scope for W1:** order placement, position tracking, fair value, quoting, risk manager, toxicity tracker, Polymarket wallet indexer, MM backtest, dashboarding.

**Verification steps at end of session:**

1. Migration applies cleanly: `npx supabase migration up` (or equivalent).
2. `npm run verify:schema` passes.
3. Tests pass: `node --test tests/ingestion/depth.test.mjs`.
4. One-shot run against demo: depth module connects, receives at least one snapshot + one delta per market in the 5-market universe, writes visible rows to `pmci.provider_market_depth` (verify with SELECT).
5. Commit plan: one migration commit + one module commit + one test commit, each with conventional-commit messages. Do not merge to main — leave on a feature branch named `mm-mvp-w1-depth-ingestion`.

**How to handle surprises:**

- If Kalshi demo WS requires paid auth or isn't accessible: stop and tell me. We'll fall back to a REST-polling simulation for W1 and revisit WS in W2.
- If the Kalshi `orderbook_snapshot` / `orderbook_delta` message format differs from what the plan assumes: surface the diff and update the plan doc before writing code.
- If an open question surfaces that's not covered in the plan, add it to a "W1 open questions" section in `docs/plans/phase-mm-mvp-plan.md` and ask me before improvising.
- **Do not** resurrect any arb-era code, invariants, or rubrics. The arb thesis is closed (see `CLAUDE.md` and `docs/archive/pivot-2026-04/`).

Begin by reading the three context files and then proposing the 5-market MVP universe (specific market tickers from `provider_markets`) for my approval before any schema or code work. Wait for me to confirm the universe, then build.

---

## After W1 completes

When this session ends with a passing W1, paste the next prompt (`docs/plans/mm-mvp-w2-session-prompt.md`) into a fresh session to start the Kalshi write client + order schema work. That prompt will be written at the end of W1 based on what we actually learned this week.

## Quick reference for the paster

- **Plan source of truth:** `docs/plans/phase-mm-mvp-plan.md`
- **Parallel workstream:** `docs/plans/phase-poly-wallet-indexer-plan.md` (not this week)
- **Archived predecessor:** `docs/archive/pivot-2026-04/` — reference only, do not revive
- **Demo Kalshi:** `https://demo-api.kalshi.co/trade-api/v2` + `wss://demo-api.kalshi.co/trade-api/v2/ws`
- **Production Kalshi (not this week):** `https://trading-api.kalshi.com/v2` — leave alone
- **Supabase project ref:** `awueugxrdlolzjzikero` (from CLAUDE.md)
