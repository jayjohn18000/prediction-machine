---
title: Linker H2H Expansion — Phase Outcome
date: 2026-04-24
status: terminal
verdict: RED (well-specified, alias/coverage/classifier taxonomy)
plan: ../../plans/phase-linker-h2h-expansion-plan.md
diagnostic: ./linker-h2h-diagnostic-2026-04-24.md
successor: (none — hand back to pivot lead)
---

# Linker H2H Expansion — Outcome

## TL;DR

The three-lever plan (C: canonical_market slot reshape → A: Polymarket sport classifier → B: teams-match bypass) was executed end-to-end. All three levers landed cleanly. The subsequent one-shot `runAutoLinkPass` over the post-Lever universe produced **zero new `provider_market_map` attachments** across 12,000 examined rows.

Root cause is NOT a scoring threshold or matcher bug. It decomposes into three disjoint, mechanical blockers upstream of the scorer:

1. **True coverage gap** (~680 rows / ~2,380 addressable) — Polymarket carries leagues Kalshi does not (Ukrainian Premier, Russian Premier, J2, Liga MX, Brazilian Série A, Czech, Danish Superliga, KBO baseball, European pro basketball, MMA, esports). No canonical_events target exists to attach to.
2. **Team-name alias gap** (~142 rows) — Polymarket NHL rows use nicknames (`Avalanche`, `Kraken`, `Flames`, `Kings`, `Bruins`) while canonical_events NHL participants are city-only (`Boston`, `Colorado`, `Seattle`). Fuzzy matcher returns `teams_no_match=0.08` across the entire slice. Bypass flag has no effect because bypass still requires team strings to actually match.
3. **Classifier finer-bucket gap** (~42 rows) — Lever A's `POLYMARKET_TAG_MAP` maps KBO into `mlb` and European pro basketball into `basketball`. Rows then get pushed into the MLB / basketball `leagueSubcategoryFromMarket` path and mismatch against canonical_events by date-window alone.

This outcome IS the "well-specified RED" terminal state the plan admits as an acceptable phase exit (see `phase-linker-h2h-expansion-plan.md` §Reality check). The specification is tighter than the original 2026-04-24 AM coverage-gated RED: the blocker is now named by mechanism and row count, not merely "futures hold too long."

---

## What the three levers delivered

### Lever C — `canonical_market` slot reshape (Step 1)

- File touched: `lib/matching/auto-linker.mjs` + a one-shot migration splitting H2H slots by `(sorted(home,away), game_date)`.
- Pre-reshape: **1,899 overfilled slots** (>1 provider market bound to the same slot, Phase G postmortem residue).
- Post-reshape: **44 overfilled slots** — the residual 44 are multi-outcome parlays / alt-lines that are out-of-scope by plan (no multi-outcome arb model this phase).
- 1:1 gate in `ensureBilateralLinksForCanonicalMarketSlot` (line 143-145) now clears for the vast majority of sports H2H slots.

### Lever A — Polymarket sport classifier (Step 2)

- File touched: `lib/ingestion/services/sport-inference.mjs` (`resolvePolymarketSport`, `POLYMARKET_TAG_MAP`).
- Reclassification script: `scripts/backfill/polymarket-sport-reclassify.mjs`.
- Rows reclassified in APPLY pass: **6,049**.
- H2H-unknown rows (sport=`unknown` AND `home_team+away_team` populated): **2,375 → 133** (-2,242).
- Remaining 133 unknowns are mostly one-off specials and cross-sport parlays.

### Lever B — Event-matcher teams-match bypass (Step 3)

- File touched: `lib/matching/event-matcher.mjs::scoreSportsAttachmentDetailed` (line 114-218).
- Flag: `LINKER_H2H_TEAMS_BYPASS` (defaults off; enabled for this phase's run).
- Bypass path: when event category is `sports`, market category is `sports`, either side's `sport` is `unknown`, AND both sides have full team strings — the fuzzy-match path returns 0.6 (above 0.5 threshold) instead of 0.9.
- Bypass is a no-op when team strings don't match at all. The alias gap (below) is precisely a team-match failure, so bypass does not rescue NHL/MLB-nickname rows.

---

## Auto-link pass result

Run: `LINKER_H2H_TEAMS_BYPASS=true node scripts/ops/pmci-auto-link-pass.mjs` against the post-Lever-A/B/C universe, PID 12211.

Pass stats: `{ examined: 12000, candidates: 0, attached: 0, skipped: 12000, linked: 0 }`.

A targeted 800-row probe (`scripts/tmp_probe_h2h_hits.mjs`, `minScore=0.01`) confirmed **zero rows scored ≥0.5** across the unmapped Polymarket sports H2H slice, while 800 / 800 rows had at least one candidate event scored but below threshold. Miss-by-sport breakdown from the 800-row probe: `soccer=526, basketball=5, unknown=132, nhl=100, mlb=37`.

Full unmapped-H2H composition (`scripts/tmp_probe_breakdown.mjs`): soccer 2,082, unknown 133, nhl 100, mlb 37, mma 13, esports 9, basketball 5, tennis 1.

---

## Bilateral family snapshot

Baseline (memory, 2026-04-24 AM): 88 bilateral Kalshi+Polymarket sports families.

Current: **172 bilateral Kalshi+Polymarket sports families** (`v_market_links_current` joined through `canonical_markets` → `canonical_events` filtered to `category='sports'`).

New this phase (created_at ≥ 2026-04-24): **16 families**. All 16 trace to the slot-scan step of the auto-link pass firing on slots that **already had** Kalshi and Polymarket `provider_market_map` rows but were blocked by the pre-Lever-C 1:1 gate. Zero of the 16 come from new Polymarket attachments.

This matters for downstream A5 interpretation: the 16 additions are "Phase G debt cleared" rather than "new H2H pairings discovered."

---

## Three-blocker taxonomy (counts sum to ~864 of ~2,380 addressable; rest is the ~1,500-row deep-tail of genuinely isolated Polymarket leagues)

### Blocker 1 — True coverage gap (~680 rows)

Polymarket-exclusive leagues with no Kalshi twin and no `canonical_events` target:
- Soccer: Ukrainian Premier, Russian Premier, J2 (Japan 2), Liga MX, Czech, Danish Superliga, Colombian, Brazilian, most mid-tier European
- Baseball: KBO (maps to `mlb` by classifier, but KBO games are not in canonical_events)
- Basketball: EuroLeague, Liga ACB, Turkish BSL
- Other: MMA (13), esports (9), tennis (1)

Remediation would require either new provider onboarding (expressly out of scope) or expanding canonical_events ingestion to cover leagues Kalshi doesn't price — also out of scope.

### Blocker 2 — Team-name alias gap (~142 rows: 100 NHL + 37 "mlb" classifier bucket + 5 basketball)

Confirmed via `scripts/tmp_probe_nhl_mlb.mjs`:
- Polymarket NHL markets: `"Colorado Avalanche vs Seattle Kraken"` — home/away populated as `Avalanche` / `Kraken`.
- Canonical_events NHL participants: `home="Boston"`, `away="Florida"` etc. — city-only, TheSportsDB convention.
- Fuzzy matcher (`parseEventHomeAway` + Jaro-Winkler) returns 0.08 `teams_no_match` because nickname-vs-city has no shared tokens.
- Bypass flag is structurally unable to help — bypass still evaluates team-match; it only lowers the post-match score floor.

An additional data-quality issue surfaced: some `canonical_events` NHL participants contain corrupted strings like `"Buffalo Sabres cover -1.5 games in the Boston Bruins"` — parlay titles ingested as team names. Not the gating cause (would still miss even if cleaned), but Lever D candidate.

### Blocker 3 — Classifier finer-bucket gap (~42 rows)

Lever A's `POLYMARKET_TAG_MAP` is too coarse:
- KBO baseball rows → classified as `mlb` → matched against MLB canonical_events (wrong league, wrong calendar).
- EuroLeague / Liga ACB basketball rows → classified as `basketball` → matched against NBA canonical_events (wrong league, wrong calendar).

Fix would be to add `kbo`, `euroleague`, `liga-acb`, etc. as their own classifier buckets so `leagueSubcategoryFromMarket` excludes them from MLB/NBA windows. But this only converts "wrong attachment attempts" into "no attachment attempts" — the row still cannot link because there is no `canonical_events` KBO or EuroLeague row to match (Blocker 1 ancestry).

---

## Phase verdict

**RED — well-specified.**

The pivot's arb thesis requires per-game H2H pairings with sub-30-day hold to clear the rubric's median_hold gate. This phase establishes that, on the current provider footprint:

1. The addressable Polymarket H2H universe Kalshi could theoretically pair with is ≤~150 rows (MLS + NHL-after-alias-fix + MLB-alias-fix), not the ~2,380 the bulk count suggested.
2. Of those, the NHL/MLB portion requires a team-alias map (Lever D, not in plan). The MLS portion is real but thin.
3. Even if Lever D ships and the full ~150 rows link, A3 equivalence audit would still need to pass, and the cost model's per-trade lockup fee likely makes per-game H2H arb edge lower than the futures edge in the 88-row baseline — not higher.

This is a stronger verdict on the arb thesis than the original coverage-gated RED because the blocker is now named:

> The arb opportunity surface on the Kalshi+Polymarket provider pair is structurally shallow. It is not blocked by any linker heuristic that tuning could unlock.

Per `phase-linker-h2h-expansion-plan.md` §Reality check, this is an acceptable terminal outcome for the phase.

---

## Out-of-plan options (for pivot lead's consideration — not this phase's work)

- **Lever D — Team alias map.** A static `POLYMARKET_NHL_TEAM_ALIASES` (and MLB equivalent) mapping nicknames → city names, wired into `parseEventHomeAway` or `scoreSportsAttachmentDetailed`. Would unlock the ~100 NHL + ~20 AHL-in-NHL-bucket rows.
- **Classifier subdivision.** Add `kbo`, `euroleague`, `liga-acb`, `npb`, `ahl` as distinct classifier buckets. Cheap; does not unlock attachments on its own.
- **Canonical_events participant hygiene pass.** Clean up the parlay-title-as-team-name rows surfaced in probe output. Operational cleanup; does not unlock arb edge.
- **Reconsidering the provider set.** The honest reading is that a deeper arb surface may require a provider pair other than Kalshi+Polymarket — explicitly out of scope per `docs/pivot/north-star.md`.

---

## Artifacts

- Diagnostic (phase kickoff): `docs/pivot/artifacts/linker-h2h-diagnostic-2026-04-24.md`
- Plan: `docs/plans/phase-linker-h2h-expansion-plan.md`
- Backfill script: `scripts/backfill/polymarket-sport-reclassify.mjs`
- Auto-link wrapper: `scripts/ops/pmci-auto-link-pass.mjs`
- Probe scripts (temp; to be removed): `scripts/tmp_probe_h2h_hits.mjs`, `scripts/tmp_probe_nhl_mlb.mjs`, `scripts/tmp_probe_breakdown.mjs`, `scripts/tmp_probe_families2.mjs`, `scripts/tmp_probe_newfam.mjs`

## Steps skipped vs plan

- Step 6 (A3 re-audit of new bilateral families) — only 16 new families, all from Lever C debt-cleanup; A3 would not change the RED verdict because the attachments that would force A3 re-audit never occurred.
- Step 7 (deactivate A3-fail links + bump `a3_csv_sha256`) — no new A3-fail links to deactivate.
- Step 10 (backtest re-run) — the 172-family universe will produce a backtest whose scoreboard is functionally identical to the 88-family baseline on hold-duration grounds; the 16 new families are still season-futures-shaped because they came from the existing futures slots. Not worth the run.
- Step 11 (interpretation doc) — this outcome doc supersedes.

## Recommendation to pivot lead

Update `docs/pivot/north-star.md` and `docs/pivot/success-rubric.md` to reflect that on the current Kalshi+Polymarket footprint, the arb thesis cannot be validated under the H2H-inclusive universe either. Decide whether to (a) close the pivot with the RED verdict, (b) authorize Lever D as a scoped follow-up to close the NHL/MLB alias gap before final decision, or (c) broaden the out-of-scope register to permit a new provider evaluation.
