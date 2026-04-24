---
title: Phase G Bilateral Linking — Cursor Implementation Strategy
tags: [phase-g, strategy, sports, bilateral-links, cursor]
status: current
last-verified: 2026-04-19
phase2: complete
phase3: complete
phase4: deferred-by-design
phase5: complete
phase6: complete
sources:
  - [[phase-g-bilateral-linking-postmortem.md]]
---

# Phase G Bilateral Linking — Strategy for Cursor

This plan converts the 2026-04-19 postmortem into a sequenced set of work for the Cursor executor. It is deliberately focused on **what to do and why** — leaving Cursor to choose the "how" (file layout, query shape, commit granularity) once each phase is opened.

## Framing

The headline from the postmortem: `linked: 0` is the **correct** output given the current slot granularity. Every bilateral-ready slot (exactly 1 Kalshi + 1 Polymarket, same canonical_market) is already paired. The work that moves the needle is not in the linker — it is in the **classifier** that decides which pm rows share a slot in the first place.

That reframing matters because it determines what counts as "done":

- We are **not** trying to push `linked` up by editing `auto-linker.mjs`. That file is working as designed.
- We **are** trying to increase the *fraction of canonical_market slots that are bilateral-ready* (currently 99 / 1,945 ≈ 5%) by changing how pm rows are assigned to slots upstream.
- Success metric is not "lines of code changed" but a specific, pre-declared shift in the slot-state distribution (overfilled → single-provider, single-provider → bilateral) measured before vs. after.

Before any classifier or migration work ships, we need to know *how much* of the solo pool is actually fixable. That is the purpose of Phase 1.

## Phase 1 — Reconnaissance (read-only sample of the solo pool)

**What:** Build a read-only sampling script that picks ~100 Kalshi-only solo slots and ~100 Polymarket-only solo slots, and for each one answers two questions:

1. Does a plausible counterpart provider_market exist on the **same canonical_event** but on a different slot? (→ semantic-mismatch, fixable by classifier work)
2. Is there no counterpart on the event at all? (→ true coverage gap, not fixable in the linker)

For "plausible counterpart" we want the strongest heuristic we can get without committing to a full classifier rewrite — e.g. title-word overlap, shared outcome term, same sport+date. The sample output should be inspectable by a human so we can spot-check the heuristic.

**Why:** The postmortem calls out that we do not know the split between coverage gap and semantic mismatch. Option A (classifier enrichment) is a meaningful investment — multiple template files plus a backfill migration — and is only worth it if semantic mismatch is the dominant class. If it turns out 80% of solos are true coverage gaps, Option A is the wrong bet and we should pivot effort into ingestion breadth instead.

**Why first:** Every subsequent phase's scope depends on this number. Starting classifier work before sizing the problem risks either over-investing (building six template extractions when the ceiling is 30 new pairs) or under-investing (shipping a draw-market rule and declaring victory while hundreds of election markets remain overfilled).

**Done when:**

- A written finding exists (markdown in `docs/plans/` or a short wiki page) with the numeric split — e.g. "of 100 Kalshi solos sampled, N have same-event Polymarket counterparts, M do not".
- The sample is categorized by segment: elections, MLB props, soccer draws, other sports, non-sports. This tells us which classifier fixes are worth writing.
- Recommendation is explicit: proceed to Phase 2, skip to Phase 3, or stop and invest elsewhere.

**Out of scope for this phase:** Any code change outside `scripts/` or `docs/`. Do not touch `lib/matching/templates/`, the classifier, or migrations.

## Phase 2 — Targeted classifier fixes (only the wins Phase 1 surfaces)

**What:** For each segment Phase 1 identifies as a meaningful semantic-mismatch pool, add the minimum classifier change that would cause both providers' pm rows to land on the same `(template, template_params)`. Candidate segments from the postmortem:

- **Election / candidate outcomes** ("Republican nominee 2028 — Katie Britt" vs. "Katie Britt"). Needs `template_params` that include a normalized candidate key.
- **MLB innings-runs / props with a line value.** Needs `template_params` that carry the line (e.g. `{side: "over", line: 4.5}`) so each Yes/No leg becomes its own slot.
- **Soccer draw markets.** The postmortem's Option B: a small regex addition so Polymarket draws stop falling into `unknown` while Kalshi draws classify as `sports-moneyline`. Likely first to ship because scope is tiny.

**Why:** These are the cases where both providers *do* list the market but the classifier splits them onto different slots or collapses too many onto one slot. A per-segment template rule, paired with a normalized outcome key (the postmortem flags "Katie Britt" vs "Senator Katie Britt" as the canonical risk), fixes the mismatch symmetrically on both sides.

**Why not just "fix them all at once":** Two reasons. First, each segment needs its own normalization — the election fix and the MLB-props fix share no code. Second, each change ships with a backfill that re-slots existing pm rows; doing them one at a time keeps the blast radius per deploy small and lets us measure the slot-state shift segment by segment.

**Guardrail:** Every template change should be paired with a counter-check — show the pre- and post-change slot distribution for the segment it targets. If a rule intended to split 35 pm rows onto 18 slots actually splits them onto 35 slots, the normalization is too aggressive and we need to tighten it before deploy.

**Done when:**

- For each targeted segment: the classifier change ships, a backfill re-slots attached pm rows, and the slot-state distribution for that segment moves from "overfilled" toward "bilateral" in a measurable way.
- Aggregate slot-state distribution (the 99 / 789 / 535 / 522 table in the postmortem) is re-run and reported.

**Out of scope:** Touching the auto-linker or the bilateral gate. The linker already pairs anything that becomes bilateral-ready after a reslot.

## Phase 3 — Option B as a quick standalone (if not folded into Phase 2)

**What:** Add the Polymarket soccer-draw rule. This is the smallest possible classifier change — one or two regex entries in `PHASE_G_SPORTS_PATTERNS` plus the matching `SPORTS_BUCKET_TO_TEMPLATE` row.

**Why:** The postmortem isolates this as a known, well-scoped mismatch worth shipping on its own if Phase 2 is still in flight. It is a low-risk proof that a classifier fix produces real new bilateral pairs, which is useful evidence when deciding whether to continue Option A.

**Why separate from Phase 2:** Phase 2 may take days or weeks if Phase 1 surfaces multiple segments. The draw-market fix should not block on that — it can ship the same day Phase 1 reports in, assuming Phase 1 confirms soccer-draw mismatch is a real segment.

**Done when:** Draw-markets on both providers classify to the same template and bilateral pairs form on next linker run. Confirm by re-querying the sport-scoped slot distribution.

## Phase 4 — Explicitly defer Option D

**What:** Do not build the "across-slot fuzzy pairing" option (D in the postmortem).

**Why:** The postmortem calls out that `market_links` is load-bearing downstream and Option D trades precision for coverage. We should not weaken that invariant until Phases 1–3 have played out and we can quantify what coverage A+B actually buy us. If after that the remaining gap is still large and clearly non-coverage, we can revisit — but with a real benchmark to compare against.

**Why call this out explicitly:** Because the attractive framing of "just loosen the match" will come up repeatedly, and the plan should say in writing that we looked at it and chose not to.

## Phase 5 — Close the open questions from the postmortem ✅ (2026-04-19)

**What:** Resolve the three "Open questions" in the postmortem in a single pass:

1. Is the "234 links" figure in `project_pmci.md` double-counting (both legs per pair → 198, not 234)? Or does it include pre-Phase-G phase-7 legacy links?
2. Are the 99 bilateral slots uniformly `link_version=75`, or mixed phase-7 + phase-G?
3. When was the last `ensureBilateralLinksForCanonicalMarketSlot` run, and did it complete cleanly or error partway through?

**Status:** Answered with live DB evidence in **`docs/plans/phase-g-bilateral-linking-postmortem.md`** § *Open questions — resolved*. Repro: **`node scripts/research/pmci-phase5-open-questions-query.mjs`** (requires `DATABASE_URL`).

**Done when:** Each open question has a one-line answer appended to the postmortem and (where relevant) to `project_pmci.md` / `project_phase_g_linking.md`. — **Postmortem updated.** Sync Claude/Obsidian memory copies manually if they live outside this repo.

## Phase 6 — Memory and wiki hygiene ✅ (2026-04-19)

**What:** Update the three affected memory and wiki surfaces to reflect the "linked=0 is correct" finding:

- `project_phase_g_linking.md` (auto-memory) — the original 3-bug diagnosis should be amended to say the three bugs were real but adjacent; the real constraint is slot granularity.
- `project_pmci.md` (auto-memory) — correct the `234 sports links` number once Phase 5 answers it.
- The Obsidian wiki entry for the phase — same correction, so future agents reading pre-compiled context don't inherit the wrong framing.

**Why:** The memory system is how the next session will frame this problem. If it still says "fix the three bugs and `linked` will go up", the next agent will chase the wrong thing. This is cheap to do and has outsized impact on future sessions.

**Done when:** ✅ **Claude local memory:** `project_phase_g_linking.md` rewritten (canonical framing + table of three bugs + repo pointers); `project_pmci.md` updated (Phase G bullet, 234 clarification, vault note). ✅ **Obsidian:** `~/Obsidian/Prediction Machine/80-phases/phase-g-bilateral-linking.md` + `Welcome.md` link. If your full vault lives elsewhere, copy or merge that note into `80-phases/` there and bump `last-verified`.

## Explicit non-goals

Things the plan deliberately does **not** include:

- **No further edits to `auto-linker.mjs` for the purpose of moving `linked` up.** The round-robin / h2h-tier change from today is a keeper; we are not adding more.
- **No new bilateral-pairing heuristic** until Phases 1–3 conclude. Option D is parked.
- **No historical/settled market backfill.** Active-markets-only invariant (from `CLAUDE.md`) still holds.
- **No changes inside `99-sources/`** of the knowledge vault.

## Ordering summary

1. Phase 1 — sample the solos, size the gap. (Read-only, ~1 day.)
2. Phase 3 — if Phase 1 confirms soccer-draw mismatch, ship the draw rule as a standalone quick win.
3. Phase 2 — per-segment classifier + backfill, one segment at a time, measuring slot-state shift each time.
4. Phase 5 — resolve the postmortem's open questions before publishing any completion writeup. ✅
5. Phase 6 — update memory and wiki to match the corrected framing. ✅
6. Phase 4 — stays deferred.

## Suggested prompt handoff to Cursor

When opening this in Cursor, start with Phase 1 only. Do not let the assistant scope-creep into classifier work before Phase 1's numbers are in. Concretely: tell Cursor "read `phase-g-bilateral-linking-postmortem.md` and `phase-g-bilateral-linking-strategy.md`, then execute Phase 1 and report back the numeric split. Do not open `lib/matching/templates/` or touch migrations in this session."
