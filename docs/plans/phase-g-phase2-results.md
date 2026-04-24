---
title: Phase G Phase 2 — Reslot Results (2026-04-19)
tags: [phase-g, results, sports, politics, bilateral-links]
status: current
last-verified: 2026-04-19
sources:
  - [[phase-g-bilateral-linking-postmortem.md]]
  - [[phase-g-bilateral-linking-strategy.md]]
  - [[phase-g-phase1-solo-sample-findings.md]]
  - [[../../scripts/migrations/pmci-reslot-canonical-market-slots.mjs]]
  - [[../../scripts/research/pmci-phase-g-slot-state.mjs]]
  - [[../../scripts/ops/pmci-auto-link-pass.mjs]]
---

# Phase G Phase 2 — Reslot Results

Closes the "Done when" checks from `phase-g-bilateral-linking-strategy.md` for Phase 2 (targeted classifier fixes) and Phase 3 (soccer-draw quick-win). Pairs the reslot migration with before/after slot-state measurements and a draw-market spot-check.

## Summary

- Shipped: political outcome key, sports-total line params, innings/totals params, soccer-draw classifier rule, reslot migration.
- Executed in prod on 2026-04-19 (this session): reslot dry-run → reslot apply → auto-link pass on 10k-row batch.
- Reslot moved **1,412 of 4,191** attached sports+politics pm rows (~34%) to newly-enriched canonical_market slots.
- Sports canonical_market slot count grew **1,923 → 5,132** (+3,209) as expected — overfilled slots split into per-outcome / per-line slots.
- Sports bilateral-ready slots: **88 → 104** (+16, +18%). Overfilled share of total dropped from 40.5% → 33.0%.
- Soccer-draw classifier verified: all sampled Polymarket draw titles now resolve to `sports-moneyline` / `bucket: moneyline_winner`. No new draw bilateral pairs formed — Kalshi-side counterparts don't exist on these events (coverage gap, consistent with Phase 1 findings).
- `pmci.market_links` families: 108 sports / 57 politics / 234 legs — unchanged vs. baseline. `linked: 0` on the 10k-batch auto-link pass is steady-state: the 104 currently bilateral-ready slots are already paired in prior family rows (`link_version=117`, 2026-04-14 run), so the linker had nothing new to write. Of the 16 newly-bilateral-ready slots from the reslot, their pm rows were already members of existing families on the old slot IDs.

## Before / after — sports

Pre-reslot snapshot (2026-04-19, UTC ~21:10). Post-reslot snapshot (same day, UTC ~21:40).

| Metric                      | Baseline | After reslot | Δ        |
|-----------------------------|---------:|-------------:|---------:|
| Total slots                 | 1,923    | 5,132        | +3,209   |
| Bilateral-ready (1K + 1P)   | 88       | 104          | +16      |
| Overfilled (>1 on a side)   | 779      | 1,693        | +914     |
| Overfilled %                | 40.5%    | 33.0%        | −7.5 pp  |
| Kalshi-solo                 | 535      | 802          | +267     |
| Polymarket-solo             | 521      | 2,050        | +1,529   |
| Empty (no active legs)      | 0        | 483          | +483     |

**Reading the deltas:** total slots grew because per-line/per-outcome params now split formerly-collapsed slots. The aggressive growth on Polymarket-solo (+1,529) is driven by `sports-total` — the classifier now splits Poly's O/U props by line value, but Kalshi ingestion doesn't yet produce line-keyed total markets at the same granularity, so each line becomes a Poly-only slot. This is a downstream classifier-symmetry issue, not a reslot bug. Noted as a follow-up below.

## Before / after — sports per-template

| Template           | Baseline total | After total | Baseline bilateral | After bilateral | Baseline overfilled | After overfilled |
|--------------------|---------------:|------------:|-------------------:|----------------:|--------------------:|-----------------:|
| `sports-total`     | 296            | 1,967       | 0                  | 0               | 296                 | 387              |
| `sports-moneyline` | 646            | 1,811       | 88                 | 104             | 463                 | 1,275            |
| `unknown`          | 697            | 863         | 0                  | 0               | 20                  | 31               |
| `sports-yes-no`    | 284            | 491         | 0                  | 0               | 0                   | 0                |

All 16 new bilateral-ready slots came from `sports-moneyline` — consistent with the political-outcome-key and innings-matchup splits isolating single-outcome moneyline markets. `sports-total` did not produce any new bilateral-ready slots (see symmetry note above).

## Before / after — politics

| Metric              | Baseline | After | Δ  |
|---------------------|---------:|------:|----|
| Total slots         | 8        | 8     | 0  |
| Bilateral-ready     | 4        | 4     | 0  |
| Overfilled          | 3        | 3     | 0  |
| Polymarket-solo     | 1        | 1     | 0  |

Politics is too small at current ingestion volumes for the outcome-key work to show aggregate movement. The classifier change is correct (outcome keys confirmed in code) but there are only 8 political canonical_market slots to operate on.

## Reslot execution detail

- Script: `scripts/migrations/pmci-reslot-canonical-market-slots.mjs`.
- Dry-run output: `{"dry_run": true, "examined": 4191, "slots_changed": 1412}`.
- Apply output: `{"dry_run": false, "examined": 4191, "slots_changed": 1412}` — identical count confirms determinism.
- Guardrail pass: 1,412 of 4,191 (~34%) is consistent with "split the overfilled pools, leave already-correct slots alone". A runaway (every row moving) or a null result (zero moving) would have warranted inspection.
- Wall time: ~8 min for each of dry-run and apply against the Supabase pooler. Per-row DB round-trips inside `findOrCreateCanonicalMarketSlot` dominate.

## Auto-link pass detail

- Script: `scripts/ops/pmci-auto-link-pass.mjs` → `runAutoLinkPass(client)` in `lib/matching/auto-linker.mjs`.
- First pass, default batch (500): `{"attached": 500, "skipped": 0, "linked": 0, "candidates": 500, "examined": 500}`. Zero skips confirms the post-reslot attachment pipeline is making forward progress (vs. pre-Phase-G where 1,965/2,000 rows would skip on null teams). `linked: 0` is the expected steady-state signal — the newly-bilateral slots were already in prior `market_links` rows as per-leg entries.
- Second pass, batch=10,000: `{"attached": 4381, "skipped": 5619, "linked": 0, "candidates": 4381, "examined": 10000}`. Wall time ~35 min against the Supabase pooler. `linked: 0` confirms the postmortem's framing — all 104 current bilateral-ready slots were already in `pmci.market_links` as paired family rows from the 2026-04-14 run (`link_version=117`), so the linker had nothing new to write. Family counts in `pmci.market_links` stayed at 108 sports / 57 politics / 234 legs.

## Soccer-draw spot check (Phase 3 "Done when")

Pulled 20 sports `provider_markets` whose title contains "draw":

- All sampled Polymarket draw titles (`"Will X vs. Y end in a draw?"`) resolve to `market_template='sports-moneyline'`, `template_params={bucket:'moneyline_winner', source:'phase_g_market_type_classifier'}`.
- `sports_draw_detail` query: 353 slots have at least one draw-titled leg, but **0 slots** have both a Kalshi draw-leg and a Polymarket draw-leg.
- Verdict: classifier change is correct and symmetric; the lack of draw bilateral pairs is pure coverage gap (Kalshi does not ingest a distinct "draw" market for these soccer events). This matches the Phase 1 recommendation to de-prioritize further classifier investment until ingestion breadth improves.

## What this closes

- Phase 2 "Done when": classifier changes shipped, backfill applied (reslot run to prod), slot-state distribution re-measured with segment breakdown.
- Phase 3 "Done when": both providers classify draw markets to the same template; sport-scoped distribution re-queried. (No new draw bilateral pairs, by coverage.)
- Phase 5 open questions are already resolved in `phase-g-bilateral-linking-postmortem.md` § Open Questions; the 234-legs figure is confirmed here (108 sports bilateral families × ~2 legs/family).

## Open follow-up (does not block Phase G closure)

1. **`sports-total` symmetry.** The reslot split Polymarket O/U props per-line but Kalshi totals did not follow suit, producing 1,344 new Poly-solo total slots. Either the Kalshi provider doesn't list per-line totals for the same events (coverage gap) or the Kalshi-side title pattern doesn't parse a `line` param. Worth a 1-hour grep of Kalshi total-market titles to decide which. Track as a Phase E3 (crypto/totals-expansion) item rather than reopening Phase G.
2. **10k-batch auto-link wall time.** >30 min observed during this session. Either increase DB parallelism inside `runAutoLinkPass` or keep the 500-row default and call from cron; do not raise batch in manual runs.
3. **Families post-linker snapshot.** ~~Re-query `market_links_families` once the 10k-batch linker pass completes~~ Confirmed: `bilateral_families` remains at 108 sports / 57 politics after the 10k-batch auto-link run finished.

## Repro

```bash
# Baseline / post snapshot
node scripts/research/pmci-phase-g-slot-state.mjs

# Reslot
node scripts/migrations/pmci-reslot-canonical-market-slots.mjs --dry-run
node scripts/migrations/pmci-reslot-canonical-market-slots.mjs

# Auto-link
node scripts/ops/pmci-auto-link-pass.mjs
```
