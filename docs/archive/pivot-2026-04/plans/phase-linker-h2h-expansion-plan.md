# Phase Linker H2H Expansion — Execution Plan

## Overview

Expand the bilateral auto-linker to cover head-to-head (per-game) sports markets so the next A5 backtest run has a chance to clear the rubric's `median_hold_days ≤ 30` gate. The 2026-04-24 A5 reading landed RED with every linked family being a season-long futures market (median_hold 55–88 days); per `docs/pivot/artifacts/linker-h2h-diagnostic-2026-04-24.md`, the sole in-guardrail move that can plausibly lift a template into YELLOW is to expand the linked universe to H2H games.

Three structural fixes, sequenced to avoid silent regression:

1. **Lever C — canonical_market slot reshape.** Per the Phase G postmortem, 789 of 1,945 sports slots are overfilled; the 1:1 bilateral gate drops them silently. Split H2H slots by `template_params` (game_date + sorted team pair) so the 1:1 gate can actually produce H2H families once Levers A+B feed into it.
2. **Lever A — Polymarket sport classification.** Add tag-id mappings for NHL, MLB, MLS, EPL, La Liga, Bundesliga, Serie A to `POLYMARKET_TAG_MAP`, then backfill existing `provider_markets.sport` rows. Unblocks ~2,375 H2H-shaped rows currently classified `sport='unknown'`.
3. **Lever B — Decouple team-match from the sport gate in `scoreSportsAttachment`.** Allow a teams-match bypass when both legs have populated `home_team`/`away_team` and category='sports', under a feature flag. A3 catches equivalence drift.

After linker changes land, run an A3 re-audit of the new bilateral families, deactivate any A3-fail links, emit a new A3 CSV and bump `a3_csv_sha256`, wait for the first H2H settlements (MLS soccer resolves in days, not months), re-run the backtest with the unchanged A5 engine, and produce a dated interpretation doc.

**Sports only.** No E2/E3. No new providers. No threshold tuning. No cleanup outside `docs/pivot/`, `docs/plans/`, `lib/ingestion/services/sport-inference.mjs`, `lib/matching/*`, and the A3 audit pipeline.

## Prerequisites

Already in place — verify before starting:

- A1 outcomes ingestion path (`npm run pmci:ingest:outcomes`) is live and writes to `pmci.market_outcomes`.
- A3 equivalence audit pipeline (`scripts/a3-audit/*` + `docs/pivot/artifacts/a3-equivalence-audit.csv`) exists and is referenced by `lib/backtest/equivalence-csv.mjs`.
- A5 backtest engine is on `arb-v1` with three-artifact output. Engine is upstream-neutral — it ingests whatever bilateral families are in `market_links` at run time.
- Auto-linker entrypoint: `lib/matching/auto-linker.mjs` and `lib/ingestion/observer-cycle.mjs::runAutoLinkPass`.
- Observer can be paused/resumed via `OBSERVER_AUTO_LINK_PASS` env.

Required reads before writing code:

- `docs/pivot/artifacts/linker-h2h-diagnostic-2026-04-24.md` — the numbers this phase exists to move. Sections "Step 1e — Linker code path trace" and "Recommended intervention priority" are normative.
- `docs/plans/phase-g-bilateral-linking-postmortem.md` — slot granularity background. Lever C is Phase G Option A.
- `docs/pivot/success-rubric.md` — GREEN/YELLOW/RED gates that the re-run will be read against.
- `docs/pivot/north-star.md` — every pivot agent reads this first.

Sub-agent split (designed for parallel Cursor dispatch via `cursor-orchestrator`):

- **Sub-agent A — Linker/matcher code.** Owns Steps 2, 3, 4 (code changes + tests for Levers A, B) + Step 5 backfill script.
- **Sub-agent B — Slot reshape + A3 pipeline.** Owns Step 1 (Lever C reslot migration + dry-run diff) + Steps 7–9 (A3 re-audit + new CSV + sha bump).
- Steps 6 (auto-link pass + inspection), 10 (outcomes wait), 11 (backtest re-run), 12 (interpretation doc), 13 (verification gate) are sequential and run in the orchestrator chat after both sub-agents merge.

## Execution Steps

### Step 1: Canonical_market slot reshape — Lever C (reslot migration)

**Owner:** Sub-agent B. **Runs first** — Levers A+B are no-ops against overfilled slots.

Introduce template_params-keyed subdivision for H2H sports slots. For every canonical_market whose `market_template` is an H2H game shape (`h2h_moneyline`, `h2h_totals`, `h2h_first_half`, `h2h_btts`, etc. — enumerate from the current `provider_markets.market_template` domain), split the slot by `(sorted(home_team, away_team), game_date)`.

Deliverables:

- `scripts/migrations/reslot-h2h-canonical-markets.mjs` — dry-run by default. Emits per-template counts diff: before/after slot counts, before/after overfilled/solo/bilateral-ready counts. Matches the diagnostic schema in the Phase G postmortem (bilateral-ready / overfilled / solos).
- `supabase/migrations/<ts>_reslot_h2h_canonical_markets.sql` — applied only after dry-run diff is reviewed. Writes new `canonical_markets` rows with `template_params = {"teams":["A","B"],"game_date":"YYYY-MM-DD"}`, repoints `provider_markets.canonical_market_id` atomically, deprecates the old overfilled rows via a `deprecated_at` column (add if missing).
- Gate: the dry-run counts diff MUST reduce the "overfilled" bucket to zero for H2H templates. If not, the script has a template_params extraction bug.
- No `market_links` rows are touched by this step. Link rows reference `provider_markets.id`, not `canonical_markets.id`, so reslotting is transparent to existing families.

**Files affected:** `scripts/migrations/reslot-h2h-canonical-markets.mjs` (new), `supabase/migrations/<ts>_reslot_h2h_canonical_markets.sql` (new), `docs/pivot/artifacts/linker-h2h-reslot-counts-diff.md` (new, written by the dry-run).

**Expected output:** After apply, the `canonical_markets` H2H slot distribution shows zero overfilled slots per the diff doc. Existing 88 futures families unaffected (futures slots are not in the H2H template set).

### Step 2: Polymarket sport classifier upgrade — Lever A

**Owner:** Sub-agent A.

Extend the Polymarket sport-inference to cover the tag-ids and league-name patterns currently returning `'unknown'`.

Changes in `lib/ingestion/services/sport-inference.mjs`:

1. Extend `POLYMARKET_TAG_MAP` (line ~296-323) with at minimum:
   - NHL tags (enumerate via a one-shot SQL query against `pmci.provider_markets` where `provider_id=2` and title contains NHL team names; inspect the `metadata->>'tag_ids'` distribution).
   - MLB tags (same method).
   - Soccer-league-specific tags: MLS, EPL/Premier League, La Liga, Bundesliga, Serie A. ALL must normalize to canonical `'soccer'` (NOT finer-grained; Kalshi returns `sport='soccer'` for all soccer leagues and bilateral match-up must be same-sport).
2. In `resolvePolymarketSport` (line ~255-282), when tag lookup fails, add a fallback path: if `metadata.events[].slug` or `title` contains clearly league-specific strings, infer sport from those. Keep the fallback conservative; it's OK to return `'unknown'` rather than guess wrong.
3. Bump `POLYMARKET_SPORT_CLASSIFIER_VERSION` constant (add one if missing) to `'v2-h2h'`.

Unit tests in `test/ingestion/sport-inference.test.mjs` cover:
- Each new tag-id resolves to its canonical sport.
- Unknown tag-id still returns `'unknown'` (no false positives).
- `metadata.events[].slug = 'mls-2026'` → `'soccer'`.
- `title = 'Ismaily SC vs. Modern SC'` with unknown tag → `'unknown'` (we don't guess from title alone on niche leagues).

**Files affected:** `lib/ingestion/services/sport-inference.mjs` (edit), `test/ingestion/sport-inference.test.mjs` (new or extended).

**Expected output:** `node --test test/ingestion/` passes. Running the classifier against a sample of 100 `provider_markets` rows where `provider_id=2, sport='unknown', category='sports'` shows ≥ 70% now classify to a canonical sport.

### Step 3: Event-matcher teams-match bypass — Lever B

**Owner:** Sub-agent A.

Loosen the sport gate in `lib/matching/event-matcher.mjs::scoreSportsAttachment` (line ~84-122) so two markets can match when both have populated teams and shared category='sports', even if one side's sport is `'unknown'`.

Rules for the bypass:

1. Gate behind env `LINKER_H2H_TEAMS_BYPASS` (default off in production, on for the backfill below and during auto-link pass in Step 6).
2. Bypass activates only when BOTH legs have `home_team` and `away_team` non-null AND both have `category='sports'`. If either side has `sport='unknown'` under these conditions, proceed to team-name matching; otherwise apply the existing sport-equality gate.
3. Team-name match uses `normalizeTeamName` + `fuzzyTeamNamesMatch` from `lib/matching/sports-helpers.mjs`. Extend `normalizeTeamName` if needed to handle common suffixes (e.g., ` FC`, ` United`, ` SC`, ` City`) — keep the change minimal and test-covered.
4. A successful bypass yields a lower base score than a true sport-match (e.g., 0.6 vs 0.9) so the candidate is proposed but not auto-accepted at high confidence. A3 re-audit in Step 7 is the hard gate.
5. Stamp `reasons.bypass_reason: 'teams_match_unknown_sport'` on the proposed `market_links` row so the A3 step can filter easily.

Unit tests in `test/matching/event-matcher.test.mjs`:
- Happy path: two markets, both sport='mlb', teams match → existing score path, ≥ 0.9.
- Bypass: Kalshi sport='mlb' + Polymarket sport='unknown', both teams populated, teams match via fuzzy → score ≥ 0.6, stamped `bypass_reason`.
- Negative: one side missing `away_team` → bypass NOT triggered even under flag.
- Negative: teams do not fuzzy-match → bypass does not produce a score.

**Files affected:** `lib/matching/event-matcher.mjs` (edit), `lib/matching/sports-helpers.mjs` (small edit if suffix handling expanded), `test/matching/event-matcher.test.mjs` (extend).

**Expected output:** `node --test test/matching/` passes. No regressions in the existing sport-equality happy path.

### Step 4: Sport backfill script

**Owner:** Sub-agent A. **Runs AFTER Step 2 merges.**

Create `scripts/backfill/polymarket-sport-reclassify.mjs`. For every `provider_markets` row where `provider_id=2` and `sport='unknown'` and `category='sports'`, run the upgraded `resolvePolymarketSport` and update the `sport` column. Idempotent — running twice changes nothing the second time.

CLI:
- `--dry-run` (default): print before/after sport distribution counts, no writes.
- `--apply`: perform the update in one transaction per 1,000 rows.
- Logs: total rows inspected, rows updated per sport bucket, rows remaining at `'unknown'`.

**Files affected:** `scripts/backfill/polymarket-sport-reclassify.mjs` (new).

**Expected output:** After `--apply`, the count of `provider_markets` with `provider_id=2 AND sport='unknown' AND category='sports' AND home_team IS NOT NULL AND away_team IS NOT NULL` drops from ~2,375 to O(a few hundred stragglers). Verified via a one-liner in the script's post-run log.

### Step 5: Auto-link pass + inspection

**Owner:** Orchestrator chat (sequential after Steps 1–4 merged).

1. Set `LINKER_H2H_TEAMS_BYPASS=true` for the linker invocation.
2. Invoke `node scripts/run-auto-link-pass.mjs --mode=full` (or the equivalent; confirm script name by reading `package.json`).
3. Capture linker metrics: `attached` count, `linked` count, breakdown by `reasons.bypass_reason`, breakdown by sport.
4. Inspect the new bilateral families:
   - `SELECT family_id, ...` with joined provider + sport + template fields for any family created in this pass.
   - Expected shape: MLS soccer first, then scattered EPL / MLB / NHL. Phase-plan-internal expectation per diagnostic: O(20–100) new bilateral families in the first pass.
5. Write `docs/pivot/artifacts/linker-h2h-first-pass-report-<date>.md` — the linker run's full metric dump and the new-families list. This is the input to Step 7's A3 re-audit.

**Files affected:** `docs/pivot/artifacts/linker-h2h-first-pass-report-<date>.md` (new).

**Expected output:** A dated report exists. `new_bilateral_families` ≥ 20. If < 20, STOP and investigate (either reslot didn't take effect, classifier didn't backfill, or bypass flag not read by the linker process).

### Step 6: A3 re-audit of new bilateral families

**Owner:** Sub-agent B (continuation of A3 pipeline ownership).

Run the existing A3 equivalence audit over the set of bilateral families created in Step 5. Reuse the existing A3 pipeline — do not fork logic; add a mode to scope the audit to a list of family_ids.

Deliverables:

- `scripts/a3-audit/run-a3-reaudit.mjs --families=<comma-list>` (or read from `linker-h2h-first-pass-report-<date>.md`).
- Output: per-family pass/fail with reason. Pass criteria inherit from the existing A3 rubric (provider markets reference the same underlying event, resolution methods compatible, prices denote the same YES event).
- Failure reasons MUST be enumerated and stored on each `market_links` row to be deactivated in Step 7 (e.g., `a3_reason='different_underlying_event'`, `a3_reason='resolution_source_divergence'`).

**Files affected:** `scripts/a3-audit/run-a3-reaudit.mjs` (new or extended), `docs/pivot/artifacts/a3-h2h-reaudit-<date>.md` (new).

**Expected output:** A dated report lists every Step 5 family as pass/fail. A fail rate > 30% triggers a pause + diagnosis (may indicate Lever B's teams-match bypass is overfiring).

### Step 7: Deactivate A3-fail links

**Owner:** Sub-agent B.

For every family flagged `fail` by Step 6:

```sql
UPDATE pmci.market_links
SET status = 'inactive',
    removed_at = NOW(),
    removed_reason = 'a3_reaudit_h2h_phase',
    reasons = reasons || jsonb_build_object('a3_reason', <reason>)
WHERE family_id = <fid>;
```

No `DELETE`. Soft-deactivation preserves the historical trail. The bilateral 1:1 gate will ignore inactive rows on future passes.

**Files affected:** `scripts/a3-audit/deactivate-a3-fail-links.mjs` (new or extended).

**Expected output:** Every A3-fail family has both legs' `market_links` rows set to `status='inactive'`. A post-run count query confirms zero `a3_reason` tags on active rows.

### Step 8: Emit new A3 CSV + bump `a3_csv_sha256`

**Owner:** Sub-agent B.

Regenerate `docs/pivot/artifacts/a3-equivalence-audit.csv` to reflect the new bilateral families and deactivations. The CSV is consumed by `lib/backtest/equivalence-csv.mjs` at engine run time; its SHA-256 stamped in `a5-backtest-meta.json` is how runs are provenance-linked.

Process:

1. Re-run the A3 audit script in full-universe mode (all current active bilateral families including pre-existing 88 futures families). This regenerates the CSV end-to-end.
2. Sort and format deterministically (match the existing script's conventions — no timestamp rows, stable sort order).
3. Compute SHA-256 of the new CSV.
4. Write `docs/pivot/artifacts/a3-equivalence-audit-prev.csv.sha256` with the old SHA (so Step 13's verification can check the bump happened).
5. Update `docs/pivot/artifacts/a3-equivalence-audit.csv.sha256` with the new SHA.

**Files affected:** `docs/pivot/artifacts/a3-equivalence-audit.csv` (regenerated), `docs/pivot/artifacts/a3-equivalence-audit.csv.sha256` (bumped), `docs/pivot/artifacts/a3-equivalence-audit-prev.csv.sha256` (written once per phase).

**Expected output:** New SHA differs from the old SHA. Old SHA matches the one stamped in the most recent `a5-backtest-meta.json` (`096f335b…842f8d65` per the 2026-04-24 interpretation doc).

### Step 9: Observer resume + wait for H2H settlements

**Owner:** Orchestrator chat.

1. Re-enable observer with `OBSERVER_AUTO_LINK_PASS=true` and `LINKER_H2H_TEAMS_BYPASS=true` on the Fly.io observer deployment. Confirm via `fly logs -a pmci-observer`.
2. Wait for the first H2H fixtures to resolve. Expected cadence per diagnostic:
   - MLS soccer: games every few days, 2026-04-24 onward.
   - EPL: weekly (Saturday/Sunday match-days).
   - MLB/NHL: late-April/May 2026 for any NHL H2H that sneaks through.
3. Cadence check: every 3–5 days, run `npm run pmci:ingest:outcomes` to pull settled outcomes into `pmci.market_outcomes` for the newly linked families. The existing `lib/resolution/*` path should handle H2H families without modification (it reads from `market_links`).
4. Gate to proceed to Step 10: the soccer template has at least 20 settled H2H fixtures (the A5 `trades_simulated ≥ 20` GREEN-broad floor). If floor can't be reached within the pivot's wall-clock budget, document this as "waiting-on-settlements" and proceed to Step 10 anyway with a smaller N + per-template-floor carve-out (`success-rubric.md` § "Parameters that may be re-tuned").

**Files affected:** None directly — deployment state change + Supabase writes via existing outcome ingestion path.

**Expected output:** `market_outcomes` gains ≥ 20 new rows corresponding to H2H bilateral families. Verify via `SELECT COUNT(*) FROM pmci.market_outcomes mo JOIN pmci.market_links ml USING (family_id) WHERE ml.reasons->>'bypass_reason' = 'teams_match_unknown_sport'` — bounded upward over time.

### Step 10: Re-run backtest (unchanged A5 engine)

**Owner:** Orchestrator chat.

Run the existing A5 engine. No engine code changes in this phase — that's the point.

1. `npm run pmci:backtest -- --interval-hours 1` (same as Phase Pivot Arb Templates verification gate).
2. Verify the three artifacts at `docs/pivot/artifacts/a5-backtest-{templates-latest,fixtures-latest,meta}.*` are fresh.
3. Confirm `a5-backtest-meta.json::a3_csv_sha256` matches Step 8's new SHA.
4. Spot-check: templates CSV has a `sports.soccer.kalshi-polymarket` row with `trades_simulated` > the pre-phase count of 8. Fixtures CSV contains rows with `family_id` values that did not appear in the 2026-04-24 run.
5. Byte-identical determinism check: run twice, `diff` must be empty.

**Files affected:** `docs/pivot/artifacts/a5-backtest-templates-latest.csv`, `…-fixtures-latest.csv`, `…-meta.json` (regenerated).

**Expected output:** Backtest completes, all three artifacts updated, determinism passes.

### Step 11: Interpretation doc

**Owner:** Orchestrator chat (separate sub-chat if desired, mirroring the A5 interpretation chat pattern).

Fill in `docs/pivot/artifacts/a5-backtest-interpretation-<new-date>.md` from the template at `docs/pivot/artifacts/a5-backtest-interpretation-template.md`. The interpretation doc MUST explicitly address:

1. **Coverage diff** — new H2H families count per sport template, vs pre-phase counts (30/29/29 from 2026-04-24).
2. **Median hold days change** — compared to the 55d / 88d pre-phase medians. Gate expectation: soccer template's median should drop under 30 if MLS/EPL H2H fixtures with ≤30-day holds are now the dominant constituents.
3. **Rubric reading** — GREEN / YELLOW / RED, with the exact thresholds checked per `success-rubric.md`. If YELLOW on soccer specifically, note which per-template thresholds cleared and which still fail.
4. **A3 deactivation rate** — how many Step 5 families were dropped by A3. If > 30%, flag Lever B bypass as overfiring.
5. **Disagreement rate** — must be ≤ 5% for any template claiming GREEN. If > 5%, that template's GREEN claim is invalid per rubric.
6. **Next decision point** — if GREEN: gate to Phase H pilot. If YELLOW: specify which template(s) need further expansion (stay within guardrails — MLS → EPL remains the within-sports wedge). If RED: which interpretation (A/B/C/D per rubric) best fits, and what the phase-closing recommendation is.

**Files affected:** `docs/pivot/artifacts/a5-backtest-interpretation-<date>.md` (new).

**Expected output:** Dated interpretation doc exists with all six sections populated, citing specific numbers from Step 10's artifacts.

### Step 12: Memory + phase record update

**Owner:** Orchestrator chat.

1. Update the `project_pivot_arb_templates.md` memory (or create a new `project_pivot_linker_h2h.md`) with the post-phase state — specifically what the interpretation doc read as (GREEN/YELLOW/RED), which templates moved, which didn't, and what the next action is.
2. If the phase closes the pivot in aggregate, annotate in `CLAUDE.md` (both repo root and workspace-level) that the pivot has landed its verdict.

**Files affected:** Memory file under `~/Library/Application Support/Claude/.../memory/`, optionally `CLAUDE.md` edits gated on phase outcome.

**Expected output:** Memory accurately reflects end-state; future sessions can load it and know the verdict.

### Step 13: End-to-end verification gate

**Owner:** Orchestrator chat. Sequential, after all prior steps complete.

Gate checks (every one must pass):

1. `node --test test/` — all tests pass, no flakes. Includes new tests from Steps 2, 3.
2. `scripts/migrations/reslot-h2h-canonical-markets.mjs --dry-run` — reports zero overfilled H2H slots.
3. `SELECT COUNT(*) FROM pmci.provider_markets WHERE provider_id=2 AND sport='unknown' AND category='sports' AND home_team IS NOT NULL AND away_team IS NOT NULL` — drops from ~2,375 to O(hundreds).
4. Auto-link pass report (`linker-h2h-first-pass-report-<date>.md`) exists; `new_bilateral_families` ≥ 20.
5. A3 re-audit report (`a3-h2h-reaudit-<date>.md`) exists; every Step 5 family has pass/fail annotation.
6. `a3-equivalence-audit.csv.sha256` differs from `a3-equivalence-audit-prev.csv.sha256`.
7. A5 artifacts are fresh: `a5-backtest-templates-latest.csv`, `…-fixtures-latest.csv`, `…-meta.json`. `meta.json::a3_csv_sha256` matches the current CSV's SHA.
8. Second backtest run produces byte-identical CSVs (determinism).
9. Interpretation doc (`a5-backtest-interpretation-<date>.md`) exists and has all six required sections populated.
10. Memory update landed.

If any check fails: fix in the relevant sub-agent's lane and re-run the gate. Do not mark phase complete on partial gate.

## Verification

Verification = Step 13. The full gate must pass before this phase is considered complete. Phase outcome (GREEN / YELLOW / RED) is set by Step 11's interpretation doc and is independent of the verification gate — gate only checks that the pipeline ran end-to-end and all artifacts are internally consistent.

## Rollback

If Lever A/B produces runaway false positives (disagreement_rate blowing up; A3 fail rate > 50%):

1. Set `LINKER_H2H_TEAMS_BYPASS=false` on the observer deployment (single env-flag flip).
2. Deactivate the Phase-created links: `UPDATE pmci.market_links SET status='inactive', removed_reason='phase_linker_h2h_rollback' WHERE reasons->>'bypass_reason' = 'teams_match_unknown_sport'`.
3. Revert Lever A sport-classifier change via git revert of the Step 2 commit. Re-run Step 4 backfill in reverse (sport='unknown' restore) for the affected rows.
4. Lever C reslot is harder to roll back — canonical_markets rows were mutated. The script in Step 1 must write an inverse-script when applied. Gate: if Step 1's apply can't generate an inverse-migration artifact alongside, do NOT apply it until that's fixed.
5. A3 CSV rollback: restore from the `a3-equivalence-audit-prev.csv.sha256`-marked prior version in git.
6. A5 engine is untouched in this phase, so no engine rollback needed.

## Out of Scope (do not let scope creep in)

- E2 (crypto) / E3 (economics) work. Explicitly forbidden by pivot `CLAUDE.md`.
- New providers (DraftKings, Manifold, etc.). Explicitly forbidden.
- Threshold tuning on the A5 rubric. No parameter changes in `success-rubric.md` defaults; the per-template floor carve-out may be INVOKED but not redefined.
- Multi-outcome arb model. 3-way soccer draw markets on Polymarket remain audit-only — the v1 binary YES/NO arb is unchanged.
- Cost model changes. If H2H settlement fees or slippage differ from A2's model in ways the backtest surfaces, that's a finding for Step 11's interpretation doc, not a change in this phase.
- Category-column cleanup. Politics rows in `provider_markets` still have polluted `category` strings; out of scope here.
- Observer ingestion changes beyond the `OBSERVER_AUTO_LINK_PASS` + `LINKER_H2H_TEAMS_BYPASS` env toggles. No observer code edits.
- New A3 rubric. A3 pass criteria are unchanged; only the audit scope expands to include the new H2H families.
- Touching the 88 pre-existing bilateral futures families. They stay in the universe; their settled subset continues to feed the backtest as before. No reslotting of futures slots.
- Linker candidate-discovery SQL edits. Per the diagnostic, `SQL_UNMAPPED` in `auto-linker.mjs` is already H2H-prioritized; do not chase `linked` by editing it.
- Frontend / lovable-ui changes. This is a backend-only phase.
- Documentation/CLAUDE.md cleanups outside the Step 12 memory + phase-record update.

> Plan file written to `docs/plans/`. To execute: tell Claude "follow the phase-linker-h2h-expansion plan in docs/plans/" — this triggers the Cursor Orchestrator. Per user's saved workflow feedback, spawn sub-agents for Steps 1 (Sub-agent B) and 2–4 (Sub-agent A) in parallel; Steps 5–13 are sequential in the orchestrator chat.
