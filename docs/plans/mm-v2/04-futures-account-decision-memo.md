---
title: MM v2 — Futures account decision memo (cross-asset hedging)
status: draft
last-verified: 2026-05-01
sources:
  - docs/plans/phase-mm-mvp-plan.md
  - /Users/jaylenjohnson/Documents/Claude/Projects/Prediction Machine/_inbox/thesis-brainstorm-kalshi-poly-structures.md
  - /Users/jaylenjohnson/audits/post-pivot-review/synthesis/post-pivot-roadmap.md
---

# Futures account decision memo

**Nature:** Decision-support only — operator records choice under Track D (`docs/plans/2026-05-01-open-decisions-for-jay.md` or successor).

---

## 1. Why this arises

MM inventory on Kalshi event contracts is **not** natively hedgeable inside the same venue at macro-factor frequency. Thesis brainstorm **#5 — Cross-asset hedging** (`_inbox/thesis-brainstorm-kalshi-poly-structures.md`) sketches hedging Kalshi exposures vs sportsbooks, equities, and rates. This memo narrows to **CME-style futures** available via US FCM/brokerage stacks.

---

## 2. Hedge menu matched to Kalshi MM categories

| Kalshi MM category (plan taxonomy) | Futures hedge candidate | Fit |
|-----------------------------------|-------------------------|-----|
| **Economics / macro** (Fed, CPI, recession prints) | **SOFR/STIR** complexity or **ZN / ZF** (rates curve) | Macro shocks move both Kalshi macro buckets and front-end rates; correlation imperfect but liquid. |
| **Crypto** (BTC/ETH threshold dailies) | **CME Bitcoin / Micro Ether** futures | Directional beta hedge for crypto-linked contracts; basis vs spot crypto remains. |
| **Politics** (election, policy risk) | **ES / NQ / RTY** equity index futures | “Risk-on/off” blunt hedge — low R² but deep liquidity; better as VAR reducer than contract-specific hedge. |
| **Sports** | **No natural listed future** | Venue-specific; residual risk stays inside Kalshi + sportsbook OTC if pursued (outside pure futures memo). |

Weather rotator markets (**ADR-010 cohort**) lack listed linear futures — hedge would require **OTC weather derivatives** (specialist brokers), **not** standard CME retail stacks.

---

## 3. Capital efficiency — rough comparison

Illustrative **not** execution advice; numbers scale linearly in first order:

Assume **$50k** incremental capital.

| Deployment | Initial margin (order of magnitude) | Notional beta per $1 cash | Comment |
|------------|-------------------------------------|-----------------------------|---------|
| Kalshi MM inventory + quotes | Exchange-defined margin / limited caps (`phase-mm-mvp-plan.md` cites Kalshi position limits) | Direct prediction-market gamma | Maker rebates help but adverse selection taxes capital. |
| **ES** futures | ~5–8% of notional (broker + SPAN variance) | ~$200k notional per ~$10–15k margin | **Higher leverage** vs leaving idle USD in MM wallet — but hedge reduces variance, not prints alpha. |
| **Micro Bitcoin** | Similar % band; often higher vol → higher SPAN | Concentrated crypto beta | Matches crypto-linked Kalshi books only. |

**Takeaway:** Futures improve **capital-adjusted Sharpe** only when correlation × hedge ratio outweighs **extra margin + fee drag**. For politics-as-equity-risk hedge, empirical ρ is often **<0.35 intraday** → hedge efficacy modest.

---

## 4. Operational complexity

| Factor | Impact |
|--------|--------|
| **Separate FCM/broker** | New KYC stack, statements, funding rails distinct from Kalshi. |
| **SPAN margin + variation margin** | Marks can **pull cash intraday** — interacts badly with Kalshi MM liquidity needs unless treasury partitioned. |
| **Reg reporting** | Large trader reporting; potential Form 1099-B complexity vs Kalshi 1099 landscape already distinct. |
| **Systems** | Hedge sizing engine + reconciliation + audit trail (which futures leg maps to which Kalshi `market_id`). |

Post-pivot roadmap posture: MM technical spine still stabilizing (7-day clock, Track E runtime questions per **CLAUDE.md**) — stacking operational surfaces multiplies failure modes.

---

## 5. Expected value sketch

| Path | Qualitative EV | Illustrative annual drag / uplift band |
|------|----------------|----------------------------------------|
| **Defer futures** | Opportunity cost of imperfect hedging. | Avoids roughly **$2–8k/yr** ops overhead + margin friction for a toy book (**<$100k**). |
| **Proceed (micro hedge)** | Variance reduction on macro/crypto sleeves. | **~5–15%** vol reduction if correlation stable → order **hundreds to low-thousands $/yr** relief on a **$50k** book (noise-dominated until inventory scales **10×**). |

---

## 6. Recommendation (non-binding)

**Defer opening a dedicated futures hedge program until:**

1. MM exit criteria / v2 inventory sizing produces **persistent directional drift** measurable post–7-day verdict.
2. Treasury policy separates **quote collateral** vs **hedge collateral** with automation.
3. At least one category (crypto or macro) shows **stable rolling correlation** vs a chosen future over ≥60 trading days.

Early-stage hedge programs rarely repay their operational tax for DEMO-scale Kalshi books.

---

## 7. Operator actions (outside this memo)

- Pick **default stance:** defer vs pilot program size ($X notional cap).
- If pilot: name broker, contract universe (ES vs ZN vs BTC), hedge ratio policy, kill-switch interaction with MM runtime.
