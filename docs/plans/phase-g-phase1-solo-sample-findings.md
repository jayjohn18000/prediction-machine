---
title: Phase G Phase 1 — Solo slot sample findings
tags: [phase-g, reconnaissance, sports, bilateral-links]
status: current
last-verified: 2026-04-19
sources:
  - [[phase-g-bilateral-linking-strategy.md]]
  - [[../../scripts/research/pmci-phase1-solo-slot-sample.mjs]]
---

# Phase 1 — Solo pool sample (2026-04-19)

Deterministic sample of sports `canonical_market` slots with exactly one provider leg (`n_kalshi=1,n_poly=0` or the reverse). For each row: does a **plausible** counterpart exist on the **same** `canonical_event` on a **different** slot (title token Jaccard ≥ 0.12, ≥2 significant token overlaps, or substring containment heuristic)?

| Pool | Sample size | Semantic mismatch (heuristic) | Coverage gap |
|------|------------:|--------------------------------:|-------------:|
| Kalshi-only solos | 100 | 6 | 94 |
| Polymarket-only solos | 100 | 5 | 95 |

**By segment (sample, not population):**

- Kalshi solos: `other_sports` 6 mismatch / 51 total in that bucket; `mlb_props` 0 mismatch / 49.
- Polymarket solos: `soccer` 4 mismatch / 46; `mlb_props` 1 / 1; `other_sports` 0 / 53.

**Recommendation:** ~94–95% of sampled solos look like **true coverage or weak title overlap** under this heuristic — not same-event counterparts on a different slot. That argues for **de-prioritizing large classifier / template-param reslot investments (Phase 2 Option A)** until ingestion breadth improves, while keeping **small targeted fixes** (e.g. soccer draw) where Phase 1 still sees mismatch mass. Re-run with tuned thresholds if we want a second opinion.

**Repro:** `node scripts/research/pmci-phase1-solo-slot-sample.mjs` (optional `PMCI_PHASE1_SAMPLE=100`). Uses `hashtext` for deterministic slot choice; requires `DATABASE_URL`.
