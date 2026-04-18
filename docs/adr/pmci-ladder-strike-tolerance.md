# ADR: Ladder strike tolerance (Kalshi vs Polymarket)

## Status
Proposed — decide before widening automated ladder linking beyond the current crypto proposer defaults.

## Context
The crypto proposer pairs strikes when relative difference is below **1%** (`strikesWithinTolerance` in `scripts/review/pmci-propose-links-crypto.mjs`). Template compatibility elsewhere may use a different scale (~10% for param strikes). Venue strike grids often do not share the same boundaries.

## Decision (to confirm)
Options: (a) keep **1%** and accept unmatched strikes; (b) widen tolerance; (c) **nearest-neighbor** mapping per Kalshi strike; (d) mixed policy by asset/series.

## Consequences
Affects proposal volume, false-positive risk, and downstream family shape for divergence features.
