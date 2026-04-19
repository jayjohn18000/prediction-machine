---
title: Phase G Bilateral Linking — Postmortem (2026-04-19)
tags: [phase-g, postmortem, sports, bilateral-links]
status: current
last-verified: 2026-04-19
phase5_open_questions: resolved 2026-04-19
phase6_memory_wiki: synced 2026-04-19
sources:
  - [[../../lib/matching/auto-linker.mjs]]
  - [[../../lib/matching/event-matcher.mjs]]
  - [[../../lib/normalization/market-type-classifier.mjs]]
  - [[../../scripts/events/pmci-seed-canonical-sports-from-markets.mjs]]
  - [[../../scripts/migrations/pmci-backfill-sports-provider-market-teams.mjs]]
---

# Phase G Bilateral Linking — Postmortem

## TL;DR

The symptom that kicked off this work — `runAutoLinkPass` returning `linked: 0` while `attached: 1156` — was **not a bug in the bilateral linker**. It is the correct output for the current state of the system: every bilateral-ready slot (exactly 1 Kalshi + 1 Polymarket on the same `canonical_market`) is already linked in `pmci.market_links` from the 2026-04-14 run. The auto-linker has nothing new to pair.

The work done today fixed three real but *adjacent* bugs in the upstream attachment pipeline (polluted team strings, duplicate canonical_events from suffix variants, Kalshi-dominated batch ordering). Those fixes are keepers. But they do not, and cannot, increase `linked` on their own, because the binding constraint is elsewhere.

**The real bottleneck: canonical_market slot granularity.** Of the 1,945 sports canonical_market slots, only 99 are in the shape the bilateral linker requires (exactly one pm row per provider). 789 are overfilled (multiple pm rows collapsed onto one slot, disqualifying them from the 1:1 gate), and 1,057 are single-provider solos (missing the counterpart). The classifier currently emits `template_params` that are too coarse to separate distinct outcome-style markets, so many semantically-different bets all land on the same slot.

## What was claimed vs. what is actually true

| Original diagnosis (Cursor handoff) | Actually true |
|---|---|
| **Bug 1:** duplicate canonical_events per game (suffix variants in dedup key) | **True.** Seeder dedup was SQL-level on raw `home_team/away_team`, so `"Milwaukee Brewers: First Inning"` and `"Milwaukee Brewers"` collapsed to different groups. Fixed (2026-04-19): JS-side dedup on sanitized keys; event count went from 3,184 → 2,944. |
| **Bug 2:** polluted `participants` JSON (colon-suffixes leaking into team names) | **True.** Upstream `provider_markets.home_team/away_team` carried suffixes like `": First Half"`, `": Quarterfinal"`, and `"Will X win the"` propositional text. Fixed (2026-04-19): expanded `TEAM_TITLE_SUFFIX_STRIP_PATTERNS` + `TEAM_SEGMENT_STRIP_PATTERNS`, added "Will … win the" guard, and made the backfill CLEAR polluted values (not skip) when the updated parser rejects a title. 220 polluted canonical_events deleted. |
| **Bug 3:** Kalshi-dominated auto-link batch (~55:1 Kalshi:Polymarket) | **True.** `SQL_UNMAPPED` ordered by `last_seen_at DESC, id DESC` alone, which favored whichever provider ingested most recently. Fixed (2026-04-19): `ROW_NUMBER() OVER (PARTITION BY provider_id, h2h_tier …)` for round-robin + h2h-ready priority. Result: batch of 500 now attaches 500/500 with mixed providers. |
| **Consequence:** once the three bugs are fixed, `linked` will go up | **False.** `linked` measures "new bilateral pairs written this run". Once a pair exists in `pmci.market_links` with `status='active'`, the linker skips it (both `famK != null && famP != null` → return 0). Every pair that *could* be bilateral under the current slot granularity is already in `market_links` from the prior run, so `linked=0` is the steady-state answer, not a failure. |

## What the three fixes *did* accomplish

They improve data quality and throughput on the attachment side, even though they don't move the `linked` counter:

- **Cleaner canonical_events.** Participants now carry clean team names, not `"Milwaukee Brewers: First Inning"`. Downstream consumers (matching scores, UI) will see sane values.
- **Cleaner team extraction.** `looksLikeMatchupMarket`-positive titles that the parser rejects no longer leave polluted `home_team/away_team` behind — the backfill nulls them so future attachment passes don't score on garbage.
- **Healthier attach throughput.** Pre-fix: 500-row batch had 1,965 skips and 35 attaches when run at 2000. Post-fix: 500/500 with zero skips. The pipeline now makes forward progress per batch instead of churning null-team rows.

These are necessary preconditions for a functioning event-first attach pipeline. They are not sufficient to create more bilateral pairs.

## What's actually blocking more `linked > 0`

Measured against live DB state at 2026-04-19:

| Slot state | Count | Can it bilaterally link? |
|---|---:|---|
| Exactly 1 Kalshi + 1 Polymarket | 99 | ✅ Already linked (family_id assigned, link_version=75) |
| Overfilled (n_kalshi>1 OR n_poly>1) | 789 | ❌ Blocked by `ensureBilateralLinksForCanonicalMarketSlot`'s exact-1:1 gate |
| Kalshi-only solo (n_kalshi=1, n_poly=0) | 535 | ❌ No counterpart on same slot |
| Polymarket-only solo (n_kalshi=0, n_poly=1) | 522 | ❌ No counterpart on same slot |
| **Total sports canonical_market slots** | **1,945** | |

And at the event level: 108 sports canonical_events have both a Kalshi-side and a Polymarket-side provider_market_map row. All of them contribute to the 99 already-linked slots. 972 events are Kalshi-only; 286 are Polymarket-only.

### Why slots are overfilled

`findOrCreateCanonicalMarketSlot` keys on `(canonical_event_id, market_template, template_params)`. When `classifyMarketTemplateForSlot` returns the same `{template, template_params}` for semantically distinct markets, they all collapse onto one slot.

**Concrete examples seen in DB:**

1. **"Republican nominee 2028" event.** One canonical_market slot with `market_template='unknown'`, `template_params={"source":"event_matcher_fallback"}`. Attached: 17 Kalshi candidate markets ("Republican nominee 2028 - Katie Britt", "… - Ted Cruz", etc.) + 18 Polymarket candidate markets ("Katie Britt", "Ted Cruz", etc.). 35 pm rows on one slot. The `template_params` does not include the candidate name, so every outcome lands on the same slot.

2. **MLB innings-runs props.** Slot with ~15 Kalshi pm rows titled "Chicago WS vs A's first 5 innings runs?" — all duplicate-titled rows (each is a Yes/No leg of a different line), all classifying to `unknown` with the same params.

3. **Soccer-draw markets.** Kalshi "Will Silkeborg IF vs. Randers FC end in [a draw]" classifies as `sports-moneyline` (matches the `/^will .+ win\b/i` pattern via the prefix) while Polymarket's "Will X vs Y end in a draw?" falls to `unknown`. They attach to the same canonical_event but **different** canonical_market slots, so never bilateralize.

### Why so many solos

Two classes, roughly:

- **True coverage gap.** The counterpart was never ingested — Kalshi has a market that Polymarket doesn't list, or vice versa. No fix possible in the linker.
- **Semantic mismatch.** A counterpart exists on the same canonical_event but classifies to a different template or different `template_params`, so it lands on a different slot. Fixable via classifier improvements or by loosening the matching key.

We don't yet have numbers on the split between these two classes — that's a research task (sampled below).

## What changed in code today (keepers, regardless of strategy)

1. `lib/normalization/market-type-classifier.mjs`
   - Added innings / quarter / half / period / round / set / "First N innings" suffix patterns to `TEAM_TITLE_SUFFIX_STRIP_PATTERNS`.
   - Duplicated the same patterns into `TEAM_SEGMENT_STRIP_PATTERNS` as a post-split safety net.
   - Added a "Will X win the Y vs Z" propositional guard in `parseMatchupTeamsFromCleanedTitle` — returns nulls so the backfill can NULL the fields.
   - Fixed a JSDoc block that got corrupted by the Edit tool (`/**` → `/\**`).

2. `scripts/migrations/pmci-backfill-sports-provider-market-teams.mjs`
   - Added the "clear on reject" branch: when `looksLikeMatchupMarket=true` but `extractSportsMatchupTeamsFromTitle` returns nulls and the prior values look polluted (colon-suffixes, "win the" phrasing), UPDATE the row to set `home_team=NULL, away_team=NULL` instead of silently skipping.

3. `scripts/events/pmci-seed-canonical-sports-from-markets.mjs`
   - Imported `sanitizeExtractedTeamSegment`; added `cleanTeamName`.
   - Moved dedup from SQL `GROUP BY` to a JS `Map` keyed on the sanitized (sport, date, away_lower, home_lower) tuple. Merges `row_count`s from suffix-variant rows.

4. `lib/matching/auto-linker.mjs` — `SQL_UNMAPPED`
   - Added `h2h_tier` CASE: rows with non-null home/away/game_date score 0, others 1.
   - `ROW_NUMBER() OVER (PARTITION BY pm.provider_id, h2h_tier ORDER BY league_tier, last_seen_at DESC, id DESC)` for round-robin inside each tier.
   - Outer ORDER BY `h2h_tier ASC, provider_rank ASC, league_tier ASC, last_seen_at DESC, id DESC, LIMIT $1`.

Effect of #4 alone: batch of 500 produces 500 attach attempts across both providers interleaved, with H2H-ready rows coming first, instead of filling the batch with null-team Kalshi rows that always skip.

## Options for unlocking more bilateral pairs

These are not mutually exclusive. Listed in rough order of expected impact / effort.

### Option A — Split overfilled slots by enriching `template_params`

**Hypothesis:** The 789 overfilled slots are the biggest pool and the lowest-hanging fruit. If `classifyTemplate` emitted distinct `template_params` for distinct outcomes (candidate name for election markets, line value for O/U markets, Yes/No side for prop markets), `findOrCreateCanonicalMarketSlot` would spread the pm rows across many single-provider slots, and pairs that share an outcome across providers would re-converge on the same slot and bilateralize.

**Scope:** Additions to `lib/matching/templates/*.mjs` per category. Also needs a backfill pass that re-classifies every existing attached pm row and moves `provider_market_map.canonical_market_id` to the new, finer slot. Not destructive if we keep old slots around, but migrations are fiddly.

**Risk:** If we split too aggressively, we create slots that should have paired but don't because the `template_params` normalization differs across providers ("Katie Britt" vs "Senator Katie Britt"). Needs a normalized outcome-key helper similar to what sports-helpers does for team names.

**Estimated ceiling:** On the order of hundreds of new bilateral pairs, once both providers contribute to a split slot.

### Option B — Add a Polymarket draw-market classifier rule

**Hypothesis:** Soccer-draw markets are a known case where Polymarket titles ("Will A vs B end in a draw?") fall to `unknown` while the Kalshi equivalent is picked up as `sports-moneyline`. Add a `btts`-like `draw_result` bucket (or send draws to `sports-yes-no` consistently) so both providers land on the same template.

**Scope:** One or two regex additions to `PHASE_G_SPORTS_PATTERNS` + corresponding `SPORTS_BUCKET_TO_TEMPLATE` entry.

**Risk:** Low. Well-scoped.

**Estimated ceiling:** Tens of new pairs (soccer-draw is a smaller segment than elections or MLB props).

### Option C — Sample the 1,057 solo slots to size the true gap

**Hypothesis:** Before investing in classifier work, we need to know what fraction of solos are coverage gaps (nothing to do) vs. semantic mismatches (classifier can fix). A 100-row random sample of Kalshi-only solos, cross-referenced against Polymarket provider_markets on the same canonical_event, would tell us the split.

**Scope:** A read-only script. One afternoon of work.

**Risk:** None.

**Estimated ceiling:** No direct impact — this is reconnaissance that determines whether Option A is worth the investment.

### Option D — Loosen the bilateral gate to "across-slot" pairing

**Hypothesis:** Instead of requiring same-slot, allow `ensureBilateralLinksFor…` to pair any Kalshi + Polymarket pair on the same `canonical_event` where the title Jaccard exceeds some threshold. Effectively moves the bilateral matching logic from "structural (same slot)" to "fuzzy (similar title on same event)".

**Scope:** New function; modifies the existing confidence-scoring path.

**Risk:** High. Kills the invariant that `market_links` is only for provably-equivalent markets. Would need a stronger scorer (or human review) to avoid pairing e.g. a moneyline against a total on the same game.

**Estimated ceiling:** Largest, but lowest precision.

## Recommendation

Do Option C first (sample the solos, ~1 day). That number decides whether to pursue A (high if most solos are mismatches) or accept that the system is roughly at its coverage ceiling and focus instead on ingestion breadth.

If C shows a meaningful fixable fraction, do A next, with B as a specific easy-win along the way.

Defer D until we have a working classifier-based approach to compare against — the precision cost is real, and the bilateral table is load-bearing downstream.

## Related memory

- `project_phase_g_linking.md` — original 3-bug diagnosis (needs update to reflect the "linked=0 is correct" finding)
- `project_pmci.md` — overall E1.6 validation, 234 sports links flowing

## Open questions — resolved (Phase 5, 2026-04-19)

Evidence: live Supabase DB (`awueugxrdlolzjzikero`) via read-only queries; reproducible with `node scripts/research/pmci-phase5-open-questions-query.mjs`.

1. **Is the “234 sports links” figure consistent with ~99 bilateral-ready slots / ~108 events?**  
   **Yes, once definitions are separated.** `234` is **`count(*)` of active `pmci.market_links` rows** whose family’s `canonical_event` is **`category = 'sports'`** — i.e. **link table legs**, not “pairs.” **`count(distinct (family_id, provider_market_id))` = 221** on the same filter; the gap to 234 is **duplicate `active` rows per leg** on **family_id 3120** (multiple `link_version`s still `active`). **`v_market_links_current`** shows **221** sports legs touching **108** families; all **108** are **equivalent** families with **both providers** represented. The postmortem table’s **99** “1 Kalshi + 1 Polymarket on the same `canonical_market` slot” counts **slots**; a Phase 5 evening re-query on the same definition returned **88** — **treat slot counts as snapshot-sensitive** and re-run `scripts/research/pmci-phase5-open-questions-query.mjs` for the current number. Link **provenance** is **legacy / `sports_proposer_v1` / `E1.6_auto_accept`**, not a single Phase G batch.

2. **Are bilateral sports links uniformly `link_version = 75` (Phase G)?**  
   **No.** Sports rows in **`v_market_links_current`** span **`link_version` 23–117** (many rows per version). **`reasons->>'source'`** is **`sports_proposer_v1`** (early), **`E1.6_auto_accept`** (38 rows at **`link_version` 29**), or **`null`** (bulk). **`count(*)` where `reasons->>'source' = 'phase_g_auto_linker'` = 0** — no links attributed to the Phase G auto-linker insert path in this database.

3. **When did `ensureBilateralLinksForCanonicalMarketSlot` last run, and did it finish?**  
   **Production DB has zero `pmci.linker_runs` rows** with **`description = 'phase_g auto-linker bilateral'`** (the string written when that path creates links). So **no successful bilateral insert from that code path is recorded** in `linker_runs`. The slot loop itself **does not persist** “evaluated N slots / completed / errored”; only **app logs** or **manual tracing** would show a partial pass. In practice, **`linked: 0`** steady-state means the function often **exits without inserting** (pairs already linked or gate not met), not that a run “failed mid-loop.”
