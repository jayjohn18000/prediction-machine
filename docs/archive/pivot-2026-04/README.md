# Archive — Arb Pivot (2026-04-24, RED terminal)

This directory holds the closed "realized-edge backtest" pivot (active 2026-04-19 → 2026-04-24) whose arb thesis terminated RED on the Kalshi+Polymarket provider pair.

## Why it's archived (not deleted)

The pivot produced real, reusable diagnostic work: A3 equivalence audit output, an A5 backtest engine, a Polymarket snapshot backfill tool, an A2 cost model, an A1 resolution-outcome ingestion path, and a three-blocker taxonomy of linker failures. Useful for two future scenarios:

1. **Revival with a different provider pair.** The arb thesis is structurally dead on Kalshi+Polymarket; it may not be on Kalshi+Pinnacle, Kalshi+DraftKings, or a future CFTC-registered Polymarket successor. If that moment arrives, start here.
2. **Reusable components for the successor thesis (MM).** `lib/resolution/` (A1), `lib/execution/costs.mjs` (A2), `lib/backfill/polymarket-snapshot-recovery.mjs`, and the observer pattern all carry over and stay in `lib/` (not archived). Only the closed-phase design docs and plans are here.

## Terminal state summary

**Verdict:** RED — well-specified. The arb opportunity surface on Kalshi+Polymarket is structurally shallow (~150 addressable rows max, all futures-shaped). Not tunable via linker heuristics, classifier subdivision, or threshold tuning. See `pivot/artifacts/linker-h2h-outcome-2026-04-24.md` for the full taxonomy.

**Final scoreboard (on the 88-family bilateral sports universe):**
- `sports.soccer.kalshi-polymarket`: 8 trades, win_rate 0.625, median_hold 55d
- `sports.nhl.kalshi-polymarket`: 1 trade, win_rate 1.0, median_hold 88d
- `sports.mlb.kalshi-polymarket`: 0 trades (all futures unsettled)
- No template clears GREEN. Median hold ≫ 30d gate.

**Known blind spot (diagnosed, not patched):** the A5 backtest had no capacity measurement — fixed `$100`/trade with flat `$0.02`/leg slippage, no order-book depth, midpoint-only pricing. See `/lib/backtest/arb-trade.mjs:110` and `/lib/execution/costs.mjs:11`. The 1–2 hour capacity patch (loop bet sizes in `arbTrade()`, emit `net_dollars_by_size`, roll up in `aggregate.mjs`) is documented but explicitly deferred as a future-provider-pair TODO.

## Successor thesis

Market making on Kalshi (Kalshi-only execution; Polymarket as on-chain information source, no Poly trading due to US-resident geoblock). See `CLAUDE.md` in the repo root for current active phase, and the thesis brainstorm doc in the Obsidian vault `_inbox/` for the full 18-thesis ranking that led here.

## Contents

- `pivot/` — the full `docs/pivot/` tree as it existed at 2026-04-24 PM (north-star, success-rubric, dependency-map, agent specs A1–A5, cursor-prompt, and all artifacts)
- `plans/` — the three arb-pivot plan files (`phase-pivot-arb-and-templates-plan.md`, `phase-pivot-arb-and-templates-schema.md`, `phase-linker-h2h-expansion-plan.md`)

## Do not

- Do not revive the arb thesis on Kalshi+Polymarket. Provider pair is the binding constraint, not anything in this directory.
- Do not apply Lever D (NHL/MLB alias map) or any linker heuristic tuning on this codebase. The outcome doc shows those would sharpen RED, not rescue it.
- Do not re-run the A5 backtest on the current universe. The 172-family output would be functionally identical to the 88-family baseline.
