# Agent A2 — Fee & Slippage Cost Model

_Read `docs/pivot/north-star.md` and `docs/pivot/dependency-map.md` before starting. You run fully in parallel with A1, A3, A4. You do not wait for anyone._

## Why this work matters

Every previous analysis in this project has looked at spreads as raw price differences. That is not net edge. A 3¢ spread on a 50¢ market looks tradeable; after Kalshi fees, Polymarket fees, estimated slippage, and the cost of locking capital until resolution, it may be negative. The backtest (A5) cannot produce a credible ranked family table without a defensible cost function. You produce that function.

The failure mode the pivot is designed to avoid is "we built a backtest that shows theoretical edge, deployed capital, and got eaten by costs we hadn't modeled." Your module is the answer to "what do we subtract from gross spread to get to real P&L."

## What success looks like

- A single module (suggested: `lib/execution/costs.mjs`) exposing a clear function contract: given venue, side, price, size, market duration → return (fees, estimated slippage, capital-lockup cost), with every component separately queryable for debugging.
- Fee schedules for Kalshi and Polymarket reflecting the current published rates as of the week you build this, sourced from each venue's public documentation, with the source URLs committed alongside the config.
- A v1 slippage model that is explicit about its assumptions (e.g., flat in cents, or a function of size vs. top-of-book depth) and documented as reviewable.
- A capital-lockup cost model that treats capital-held-until-resolution as a financing cost at a documented opportunity rate (e.g., risk-free T-bill rate) — small but non-zero, and matters more for long-hold families.
- A short README beside the module explaining every assumption in plain language, so the rubric (`success-rubric.md`) can be applied honestly when interpreting backtest output.

## The honest-assumptions rule

Every parameter you hardcode is a place the backtest can lie to the owner. For each fee rate, slippage constant, or financing rate:

- State the value.
- State the source (URL + date observed).
- State the confidence ("published by venue" vs. "estimated from my own orderbook observations" vs. "guessed, TODO").
- State what would change it.

A backtest that says "$1.20 net edge per $100" is meaningless if the cost model rests on a guessed slippage number. The cost model's credibility is the backtest's credibility.

## Scope boundaries

**In scope:**
- Fee + slippage + capital-lockup cost function, usable from the backtest.
- Static config files for published fee schedules.
- v1 slippage model with explicit assumptions.
- README documenting every assumption.

**Out of scope:**
- A slippage model that reads live orderbook depth. That's v2, post-backtest, if the backtest shows it's worth building.
- A latency/stale-read model. v1 assumes simultaneous fills; document that assumption. v2 post-backtest if relevant.
- Per-family overrides. v1 is one model applied uniformly. Family-specific tuning is a follow-on only if the backtest reveals systematic per-family cost divergence.
- Building a full Phase F1 tradability platform. You are producing one function, not a platform.

## What "done" requires you to prove

1. A call to `estimateCost({ venue: 'kalshi', side: 'yes', price: 0.52, size: 100, hold_days: 14 })` returns a defensible number with a breakdown.
2. Every hardcoded value has a source and date comment.
3. The README includes a "when this model will lie to you" section listing the assumptions most likely to cause realized vs. modeled divergence.
4. A5 can integrate the module with a single import, no hidden globals.

## Things to escalate

- If Kalshi or Polymarket fees have changed recently and the published schedule is ambiguous, flag and ask for owner judgment rather than guessing.
- If slippage estimation requires historical orderbook snapshots that don't currently exist in the DB, note it — v1 can use a flat estimate, but the gap should be documented.

## What not to do

- Do not build an orderbook-depth-aware slippage estimator in v1. It's unnecessary for the go/no-go decision.
- Do not add per-venue fee tiers based on volume discounts unless the pilot capital range ($5k–$25k) would realistically hit them (it won't — not yet).
- Do not over-engineer. One function, one README, honest assumptions.
