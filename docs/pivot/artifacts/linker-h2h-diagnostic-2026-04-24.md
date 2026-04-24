# Linker H2H Expansion — Diagnostic (2026-04-24)

_Read-only universe audit answering whether expanding the auto-linker to head-to-head (H2H) game markets can plausibly lift the A5 scoreboard off a structural `median_hold_days` RED. Numbers first; interpretation at the end._

---

## TL;DR

1. **The linked sports universe is 100% season futures** — all 88 bilateral families have zero H2H legs on either side. This is exactly what the 2026-04-24 interpretation doc predicted.
2. **Kalshi has 4,547 active H2H-shaped sports markets, 100% unlinked** (434 MLB / 714 NHL / 3,399 soccer, covering ~1,255 unique fixtures).
3. **Polymarket's per-game H2H inventory is dramatically thinner than Kalshi's, and concentrated in non-overlapping leagues.**
   - MLB per-game H2H: **0 on Polymarket** (true coverage gap, not a classifier miss).
   - NHL per-game H2H: **0 on Polymarket** (true coverage gap).
   - Soccer per-game H2H: abundant on both, but league coverage diverges — Kalshi = EPL/La Liga/Bundesliga heavy; Polymarket = Saudi/Egyptian/Japanese/Indian leagues heavy.
4. **The hypothesis survives but only for soccer, and only narrowly.** The addressable H2H wedge for Kalshi↔Polymarket is roughly: MLS + sliver of EPL + odd ad-hoc overlaps. A same-window fuzzy fixture-match across 2026-04-24…2026-05-15 (~3 weeks of top-6 league coverage) found **2 cross-venue fixture pairs** after a permissive winner/draw filter. Scaled out, the plausible addressable-H2H universe is likely O(50–300) trades/season — not O(thousands) — before equivalence filtering.
5. **The linker's candidate SQL is not the bottleneck.** It already prioritizes H2H (`h2h_tier = 0`) and sport-pair heuristics. What is blocking H2H links is upstream — Polymarket sport classification + team-name convention mismatch — and downstream — canonical_market slot granularity (Phase G Option A).
6. **Three levers identified, ranked by leverage/effort.** Lever A (Polymarket sport classifier) cheap and correct but small ceiling given coverage gap. Lever B (decouple team-match from sport gate in event-matcher) free and safe. Lever C (split overfilled slots via template_params) the structural move needed once Levers A+B unblock flow.
7. **Reality check on the YELLOW case.** Even with Levers A+B+C landed and all plausible H2H linked, the 88→~100–250 settled-family ceiling by MLS/EPL season end 2026 looks like the realistic upper bound. Whether that lifts any template above the GREEN per-template thresholds is an empirical question the re-run will answer — but it is NOT guaranteed. A well-specified RED on a wider, H2H-inclusive universe is still a possible landing, and that RED would be a stronger verdict on the arb thesis than the current coverage-gated RED.

---

## Method notes

- Data pulled 2026-04-24 from `awueugxrdlolzjzikero` (Supabase `pmci` schema).
- "Active" = `provider_markets.status = 'active'`.
- "H2H-shaped" heuristic = `home_team IS NOT NULL AND away_team IS NOT NULL` OR title matches `( vs | @ )`. In practice `both_teams=NOT NULL` is the stricter test and is used below.
- "Linked" = provider_market_id present in any `market_links` row with `status='active'`.
- "Unique fixture" = `DISTINCT (sport, home_team, away_team, game_date)`.
- "Twin candidate" = fuzzy title match (`home` and `away` team strings both appear in poly title) within ±1 day of Kalshi's game_date.

---

## Step 1a / 1b — H2H universe counts per provider × sport

Active H2H-shaped rows (`home_team` and `away_team` both non-null) on 2026-04-24:

| provider | sport | total active | H2H-shaped | share H2H |
|---|---|---:|---:|---:|
| kalshi | mlb | 1,471 | **434** | 30% |
| kalshi | nhl | 1,696 | **714** | 42% |
| kalshi | soccer | 4,955 | **3,399** | 69% |
| polymarket | mlb | 63 | **0** | 0% |
| polymarket | nhl | 690 | **0** | 0% |
| polymarket | soccer | 4,856 | **2,058** | 42% |
| polymarket | **unknown** | 6,897 | **2,375** | 34% |

Kalshi H2H total across target sports: **4,547** (100% unlinked — see 1c below).

Polymarket H2H, after adding the `sport='unknown', category='sports'` bucket: **4,433** (of which 2,058 classified soccer, 2,375 mis-classified). Almost all are niche-league soccer by league composition (see 1d).

### Kalshi H2H breakdown: moneyline vs prop

The linker is biased toward moneyline-shaped markets for bilateral pairing; props (totals, BTTS, first-half, O/U) cluster around a fixture but resolve differently.

| sport | total H2H-shaped | winner-like | prop-like | unique fixtures |
|---|---:|---:|---:|---:|
| mlb | 434 | 125 | 164 | 50 |
| nhl | 714 | 130 | 584 | 77 |
| soccer | 3,399 | 2,389 | 1,222 | 1,128 |

Unique addressable Kalshi H2H fixtures (sport × home × away × date) across mlb/nhl/soccer: **1,255**.

## Step 1c — Kalshi H2H linked status

| sport | H2H-shaped total | linked (active market_links row) | unlinked |
|---|---:|---:|---:|
| mlb | 434 | **0** | 434 |
| nhl | 714 | **0** | 714 |
| soccer | 3,399 | **0** | 3,399 |
| **total** | **4,547** | **0** | **4,547** |

**100% of Kalshi sports H2H markets are unlinked.** Not a single active `market_links` row touches a Kalshi H2H leg. All 59 active Kalshi↔Polymarket bilateral sports legs are pure season futures (championship / divisional / totals-season, etc.).

Confirmation on the family side (bilateral 1 Kalshi + 1 Polymarket):

| sport | bilateral families | families with any H2H leg | families with all H2H legs |
|---|---:|---:|---:|
| mlb | 30 | 0 | 0 |
| nhl | 29 | 0 | 0 |
| soccer | 29 | 0 | 0 |
| **total** | **88** | **0** | **0** |

This matches the A5 interpretation doc's "linker is picking up only season futures" characterization — it is not a modeling claim; it is the literal state of the database.

## Step 1d — Hand-check: Kalshi H2H ↔ Polymarket twin

Sampled 13 unlinked Kalshi H2H fixtures in the 2026-04-24…2026-05-05 window (7 NHL + 6 soccer; MLB has no playable games in that window — all MLB H2H rows in the window are 2026 regular-season games whose `game_date` falls later). For each, searched Polymarket ±1 day for titles containing both team names.

| sport | k_title | k_home / k_away | game_date | poly_both_in_title | poly_either_in_title |
|---|---|---|---|---:|---:|
| nhl | San Jose vs Anaheim: Total Goals | Anaheim / San Jose | 2026-04-24 | 0 | 9 |
| nhl | Nashville vs Utah: Total Goals | Utah / Nashville | 2026-04-24 | 0 | 0 |
| nhl | Minnesota vs Dallas: Total Goals | Dallas / Minnesota | 2026-04-24 | 6 | 21 |
| nhl | Calgary vs Colorado: Total Goals | Colorado / Calgary | 2026-04-24 | 0 | 9 |
| nhl | Carolina vs Chicago: Total Goals | Chicago / Carolina | 2026-04-24 | 0 | 9 |
| nhl | Winnipeg vs St. Louis: Total Goals | St. Louis / Winnipeg | 2026-04-24 | 0 | 0 |
| nhl | Vancouver at Los Angeles Winner? | Los Angeles / Vancouver | 2026-04-24 | 0 | 19 |
| soccer | Wolverhampton at West Ham: BTTS | West Ham / Wolverhampton | 2026-04-24 | 0 | 0 |
| soccer | West Ham vs Wolverhampton: 1H Winner? | Wolverhampton / West Ham | 2026-04-24 | 0 | 0 |
| soccer | Wolverhampton at West Ham: Totals | West Ham: Totals / Wolverhampton | 2026-04-24 | 0 | 0 |
| soccer | Real Madrid vs Girona: 1H Winner? | Girona / Real Madrid | 2026-04-24 | 0 | 0 |
| soccer | Girona at Real Madrid: BTTS | Real Madrid / Girona | 2026-04-24 | 0 | 0 |
| soccer | Augsburg vs Hoffenheim: 1H Winner? | Hoffenheim / Augsburg | 2026-04-24 | 0 | 0 |

**Hit rate: 0/13 true twins.** The single "6 both-in-title" row (Minnesota vs Dallas NHL) resolved to "Will FC Dallas vs. Minnesota United FC end in a draw?" — an MLS soccer match, not the NHL game. False positive on team-name overlap.

Zoomed-out league-composition check on Polymarket's soccer + unknown-sport H2H inventory in the next 3 weeks (2026-04-24…2026-05-15):

| poly league bucket | rows |
|---|---:|
| Other (niche: Saudi, Egyptian, Japanese, Indian, South American, etc.) | 1,556 |
| MLS | 90 |
| EPL | 12 |
| La Liga | 1 |
| Bundesliga / Serie A | 0 |

**Kalshi vs Polymarket coverage asymmetry:**

- Kalshi EPL + La Liga + Bundesliga fixtures today: abundant (West Ham–Wolves, Real Madrid–Girona, Augsburg–Hoffenheim all present).
- Polymarket same: 12 EPL, 1 La Liga, 0 Bundesliga.

**MLS direct overlap probe (2026-04-24…2026-05-15):**

- Kalshi unique MLS fixtures: 44
- Polymarket unique MLS fixtures: 20
- Potential max-overlap pairings (assuming 100% team-match success): ≤20 in a 3-week window → rough-order ~180–240/season if sustained. A 2-hit fuzzy-matching SQL probe against the same window returned 2 cross-venue fixture pairs under a permissive `(winner|beats|will X win|draw)` filter, suggesting the naive-fuzzy hit rate is ~10% but climbable with Lever A+B.

**Finding:** The H2H twinning failure is a two-sided problem.
1. **Upstream classification:** Polymarket's unknown-sport bucket holds 2,375 `category='sports'` H2H markets with teams populated, but the classifier returns `sport='unknown'` and the event-matcher's sport gate zeroes those out before any team-level match is tried. This is Lever A + B territory.
2. **True coverage gap:** For MLB and NHL per-game markets, Polymarket simply has near-zero inventory (`mlb=63, h2h=0`; `nhl=690, h2h=0`). No linker change fixes this. The MLB + NHL H2H universe on Kalshi (434 + 714 = 1,148 markets, 127 unique fixtures) is essentially non-addressable against Polymarket.
3. **League mismatch:** Kalshi soccer skew is top European leagues + MLS; Polymarket soccer skew is MLS + niche non-European leagues + scattered EPL. Real overlap is roughly MLS + a few EPL weeks.

The realistic H2H addressable universe, ordered by density: **MLS → EPL → niche soccer → effectively none for MLB/NHL**.

## Step 1e — Linker code path trace

Entry flow, roughly in order of execution per auto-link pass:

```
observer-cycle.mjs::runObserverCycle  (line ~313, ~407)
  └─ runAutoLinkPass(ctx)          (gated by env OBSERVER_AUTO_LINK_PASS)
       │
       ├─ loadUnmappedMarkets       (SQL_UNMAPPED)
       │     └─ pulls provider_markets rows with no canonical_markets FK,
       │        round-robin by provider + h2h_tier=0 priority for sport markets
       │        with (home_team IS NOT NULL AND away_team IS NOT NULL)
       │
       ├─ per-market:
       │     classify() → market_template + template_params
       │       │
       │       └─ sport-inference.mjs::resolvePolymarketSport
       │            └─ POLYMARKET_TAG_MAP lookup (line 296-323)
       │                 └─ returns 'unknown' if tag_id numeric + not mapped
       │
       ├─ ensureCanonicalEventForMarket    (creates/reuses canonical_events)
       ├─ ensureCanonicalMarketSlot         (key: market_template + template_params)
       └─ ensureBilateralLinksForCanonicalMarketSlot  (1:1 gate at line 143-145)
             └─ writes market_links rows only if slot has EXACTLY
                1 Kalshi leg + 1 Polymarket leg
```

Downstream score function that decides whether an H2H Kalshi↔Polymarket pair can even be proposed:

```
event-matcher.mjs::scoreSportsAttachment  (line 84-122)
  ├─ returns 0 if either side has sport == 'unknown'
  └─ returns 0 if either side lacks home_team/away_team
```

### Lever map

**Lever A — Polymarket sport classification.** File: `lib/ingestion/services/sport-inference.mjs`. Function: `resolvePolymarketSport` (line 255-282). Table: `POLYMARKET_TAG_MAP` (line 296-323). The map is small and tag-id-based. Adds needed: tags for `nhl`, `mlb`, plus common soccer league aliases (`epl`, `mls`, `laliga`, `bundesliga`, `serie-a`) into their canonical sport. Cheapest fix; directly unblocks 2,375 H2H rows from the unknown bucket. Ceiling is capped by true coverage gap (MLB/NHL Polymarket inventory is near-zero regardless of tagging).

**Lever B — Decouple team-match from sport gate.** File: `lib/matching/event-matcher.mjs::scoreSportsAttachment` (line 84-122). Today returns 0 when `sport='unknown'` even if both sides have `home_team`/`away_team` and those teams match. Change: allow a "teams-match bypass" when BOTH legs have populated teams AND team names fuzzy-match under `normalizeTeamName` (`lib/matching/sports-helpers.mjs` line 1-33). Safety: still require both sides to share `category='sports'`. Also cheap, independent of Lever A, and A3 will catch any false equivalence survivors before the backtest trusts them.

**Lever C — Slot granularity (Phase G Option A).** File: `lib/matching/auto-linker.mjs::ensureBilateralLinksForCanonicalMarketSlot` (1:1 gate line 143-145). Problem: per Phase G postmortem, 789 of 1,945 sports `canonical_market` slots are overfilled (more than one leg per side on the same slot) → 1:1 gate silently drops them. Fix: split by `template_params` keyed on game_date + team pair for H2H templates. Requires a reslot migration, which Phase G Option A has already scoped.

**Anti-lever (confirmed not a blocker).** The `SQL_UNMAPPED` candidate-discovery query in `lib/matching/auto-linker.mjs` (line 242-279) is NOT the bottleneck — it already surfaces H2H-shaped rows first via `h2h_tier = 0` and sport priority. Do not chase linked-count by editing this query; the blockers are upstream classification + downstream slot shape, not candidate selection.

### Attachment ordering (for completeness)

`SQL_UNMAPPED` (line 242-279) orders candidates by:
1. `h2h_tier = 0` first (h2h-ready: home+away both populated).
2. Round-robin across provider_id (prevents Kalshi-dominated batches — fixed in Phase G).
3. Sport priority: `mlb, nba, nhl, mls, epl, soccer` first.

This ordering is correct for the H2H expansion — no change needed.

## Phase G crosscheck

Phase G postmortem (`docs/plans/phase-g-bilateral-linking-postmortem.md`) already catalogued the slot shape problem:

| slot state | count | meaning |
|---|---:|---|
| bilateral-ready (1 K + 1 P) | 99 | passes the 1:1 gate → becomes a family |
| overfilled | 789 | 1:1 gate drops them silently |
| solos | 1,057 | slot has only one provider's leg |

The 88 active sports families correspond to this "bilateral-ready" set minus dead/cancelled legs. Lever C directly attacks the 789 overfilled slots. Levers A+B directly grow the solos pool (and the bilateral-ready pool, if the unknown-bucket unblock pairs cleanly).

## Interpretation — what this says for the H2H expansion phase

### 1. The A5 "structural RED" claim is confirmed empirically

Every linked sports family is a season futures market. Zero are H2H. The median_hold_days ceiling (≤ 30 days) cannot be cleared by any of the 88 families currently in the pool nor by any of the 64 unsettled families settling later in 2026 — they are all futures with multi-month holds by construction.

### 2. The A5 interpretation doc's prescribed lever is the right lever, but narrower than expected

"Expand the linker to H2H games" is the correct architectural response. The surprise is scale: the plausible addressable pool is much smaller than the 4,547-unlinked-H2H-rows headline implies because:

- MLB + NHL per-game markets are a one-sided universe (Polymarket absent). ~1,148 Kalshi H2H rows → ~0 equivalent families.
- Soccer's cross-venue overlap is concentrated in MLS + thin EPL. A 3-week top-league window shows ~20 potential MLS fixture pairings; extrapolated to a full season that is ~150–250 pairings, then reduced by A3 equivalence to some subset.

### 3. Two cases survive for the phase

- **Case 1 (YELLOW-plausible):** Levers A+B land, Polymarket sport classifier upgraded, event-matcher bypass added. A3 re-audit filters the new link candidates. H2H-shaped soccer MLS + EPL families flow into the pool. First re-run backtest could plausibly lift median_hold_days below the 30-day ceiling for the soccer template; whether win_rate and mean_edge clear the per-template GREEN thresholds is an empirical question.
- **Case 2 (well-specified RED):** Same levers land, A3 filters aggressively, the arb edge on per-game H2H is no better than the futures edge (or worse: higher lockup fees on short-dated, frequent-trade path). The re-run lands RED on mean_edge rather than median_hold_days, and that RED is a far stronger verdict on the arb thesis than the current coverage-gated RED.

Both cases are phase-completing outcomes under the success-rubric definition.

### 4. Out-of-pocket risk for the phase

Three specific risks to watch:
- **A3 overfires on team-name fuzzy matches.** Lever B's teams-match bypass relies on `normalizeTeamName` + `fuzzyTeamNamesMatch`, which today has no short→full name map (e.g., "San Jose" vs "San Jose Sharks" vs "San Jose Earthquakes"). A3 must deactivate non-equivalent links; any that slip through will show up as `disagreement_rate > 0` in the re-run and must drop the offending template out of the scoreboard.
- **Polymarket per-game liquidity.** Even classified and linked, Polymarket per-game books may have thin depth, dragging up slippage beyond the cost model's assumptions. Not a linker problem — it's a backtest-reads-snapshots problem — but flag it for the interpretation doc.
- **Slot-overfill regression.** If Levers A+B land before Lever C, the unknown-sport H2H inflow will pile into already-overfilled slots and the 1:1 gate will silently continue dropping them. Sequence: ship Lever C's reslot FIRST, then Lever A, then Lever B.

## Recommended intervention priority

Proposed sequence for Step 2's phase plan:

1. **Lever C first** — reslot canonical_market slots via `template_params` on H2H templates (Phase G Option A). Dry-run + counts diff, then apply. Unblocks the pile that Levers A+B will feed into.
2. **Lever A** — Polymarket sport classifier upgrade. Add NHL, MLB tag mappings (even though poly has near-zero supply); critical: map all common soccer league tags (EPL, MLS, La Liga, Bundesliga, Serie A) to canonical `soccer`. Backfill existing rows.
3. **Lever B** — Event-matcher teams-match bypass when both sides have populated teams and category='sports'. Guarded behind a feature flag.
4. **A3 re-audit** of the newly linked bilateral families. A3-fail links must be deactivated (set `market_links.status='inactive'` with `removed_reason='a3_reaudit_h2h_phase'`). Emit a new A3 CSV and bump `a3_csv_sha256` in the engine meta JSON.
5. **Wait for settlements.** The first MLS + EPL H2H games will settle within days, not months, so the re-run can start producing post-settlement fixture rows quickly. Target: enough settled H2H families to clear the per-template trade-count floor for the soccer template.
6. **Re-run backtest, unchanged A5 engine.** The engine does not care about H2H vs futures; it just ingests settled families. Produce dated interpretation doc under `docs/pivot/artifacts/a5-backtest-interpretation-<new-date>.md`. Expected outcome: either YELLOW on soccer template (phase done, green-light go/no-go conversation) or well-specified RED (phase done, verdict on thesis).

## Universe-scale summary for the phase

| aspect | number |
|---|---|
| currently linked bilateral sports families | 88 (all futures) |
| Kalshi active H2H markets, sports | 4,547 |
| Kalshi active H2H unique fixtures, sports | 1,255 |
| Kalshi H2H linked | 0 |
| Polymarket active H2H markets, sports + unknown-sports-category | 4,433 |
| Polymarket H2H in MLB / NHL | 0 / 0 |
| Polymarket H2H unique fixtures, MLS (next 3 wks) | 20 |
| Polymarket H2H unique fixtures, EPL (next 3 wks) | ~12 markets, fewer unique fixtures |
| Fuzzy cross-venue fixture overlap, MLS+all soccer, 3 wks | 2 pairs |
| Plausible addressable H2H universe, next 12 months | O(100–500) pairings pre-A3 |
| Expected settled families for re-run within 30 days | O(20–50), mostly MLS soccer |

This is the structural ceiling on what the phase can produce. Everything past Lever A/B/C is downstream of it.

---

_Companion step_: this diagnostic is consumed by Step 2 (`docs/plans/phase-linker-h2h-expansion-plan.md`) and Step 3 (code + re-run). The phase plan will turn the Recommended intervention priority above into numbered steps with gate checks and the explicit A3 re-audit gate._
