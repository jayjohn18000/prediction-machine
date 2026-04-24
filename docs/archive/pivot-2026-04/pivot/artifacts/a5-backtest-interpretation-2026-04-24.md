# Backtest Interpretation — 2026-04-24 (post-audit)

_First arb-v1 run after the refactor, the Polymarket snapshot backfill, **and** the family 3218 audit. The scoreboard is now honest. This document closes the pivot's A5 loop: refactor landed, gates pass, forensic flag investigated and patched, final GREEN/YELLOW/RED reading below._

---

## Run inputs (from `a5-backtest-meta.json`)

| field | value |
|---|---|
| `engine_version` | arb-v1 |
| `cost_model_version` | v1 |
| `template_definition_version` | sports-v1 |
| `entry_threshold_abs` | 0.01 (per $1) |
| `interval_ms` | 3600000 (hourly) |
| `premium_per_trade_usd` | 100 |
| `void_refund_model` | full_refund_v1 |
| `a3_csv_sha256` | `096f335b…842f8d65` |
| `settled_family_count` | 24 |
| `total_family_count` | 88 |

## Coverage at a glance

| sport | active families | settled (both-leg outcomes) | trades_simulated |
|---|---|---|---|
| mlb | 30 | 0 | 0 |
| nhl | 29 | 14 | 1 |
| soccer | 29 | 10 | 8 |
| **total** | **88** | **24** | **9** |

Drop-off accounting (88 → 9):
- 64 skipped — `outcomes_missing` (unsettled season-long futures; resolve later in 2026)
- 15 skipped — `no_entry_found` (spread never crossed the $0.01 entry threshold during the ingestion window)
- 0 skipped — `degenerate_prices` (resolved upstream: Polymarket CLOB backfill on 2026-04-24 populated all 88 bilateral pmids, avg ~650 points each)
- 0 skipped — `a3_non_equivalent` (pre-filtered via A3 CSV)

## Per-template scoreboard (final)

| template_id | trades | win_rate | mean_net_edge_per_100 | total_pnl | median_hold_days | disagreement_rate | void_rate |
|---|---|---|---|---|---|---|---|
| `sports.soccer.kalshi-polymarket` | 8 | 0.625 | $0.25 | $2.02 | 55 | 0 | 0 |
| `sports.nhl.kalshi-polymarket` | 1 | 1.000 | $0.56 | $0.56 | 88 | 0 | 0 |
| `sports.mlb.kalshi-polymarket` | — | — | — | — | — | — | — |

P&L distribution across all 9 traded fixtures (post-audit):

```
−$0.59, −$0.58, −$0.16, +$0.08, +$0.16, +$0.56, +$0.64, +$1.05, +$1.42
```

Tight cluster in [-$0.59, +$1.42]. No structural outliers. The previous +$101.22 windfall is now +$0.16 at its true value.

MLB has zero trades — all 30 MLB bilateral families are unsettled futures markets (2026 World Series); none had outcomes at run time.

## Family 3218 audit — resolved (resolver bug, patched)

The interpretation from the pre-audit run flagged family 3218's +$101.22 windfall as almost certainly a bug per the A5 brief's "50%+ single-family edge is a bug, not a finding" rule. The audit confirmed that and identified the exact defect.

**Data pulled for family 3218:**
- Kalshi leg: `KXBUNDESLIGA-26-BMU`, "Will Bayern Munich win the Bundesliga?", `winning_outcome="yes"`, resolved 2026-04-19
- Polymarket leg: `0xf2a4a7765e…` (condition_id), "Will Bayern Munich win the 2025–26 Bundesliga?", `winning_outcome="Yes"`, resolved 2026-05-28

Both legs reference the same underlying event. Both resolved in favor of Bayern. A3 classification is correct — this is a genuine equivalent pair.

**Root cause:** `lib/backtest/leg-payout.mjs::polyLongYesPays` was written assuming Polymarket's `winning_outcome` is always a team label derivable from either a `#outcome` suffix in `provider_market_ref` or from `home_team`/`away_team`. That assumption holds for head-to-head game markets but fails for championship / futures markets, where the venue returns the literal `"Yes"` or `"No"` and there is no team label on the row. For family 3218 all fallback paths failed and the function returned `false`, meaning "long-YES does not win" — i.e., the resolver told the engine that YES had lost on Polymarket when in fact YES had won. Combined with the arb construction (long-NO on the expensive side), that produced the `cheap_state=won, exp_state=won` pattern.

**The bug was latent across all 29 Polymarket settled legs.** 28 of them happened to return the correct answer by accident — they have `winning_outcome="No"` (every non-winning team's championship question), the function returned `false`, and for those "long-YES does not win" is the correct conclusion. Family 3218 was the sole case where the fallback's implicit false-means-no-win answer diverged from reality.

**Fix:** added a canonical literal-Yes/No handler to `polyLongYesPays`, checked before the ref/team fallbacks:

```js
if (w === "yes") return true;
if (w === "no") return false;
```

**Regression tests added** in `test/backtest/leg-resolver.test.mjs` — 5 new tests covering the futures shape (bare condition_id, null home/away teams, literal Yes/No outcomes) for all four (side × outcome) combinations plus a case-insensitivity check.

**Post-patch state of family 3218:** `cheap_state=won, exp_state=lost`, net_dollars = +$0.16. That sits right in the body of the other traded fixtures.

## Rubric reading — RED (coverage too thin to demonstrate edge)

The success rubric requires per-template thresholds be met before GREEN/YELLOW are available:

| rubric path | requirement | soccer (n=8) | nhl (n=1) | mlb (n=0) |
|---|---|---|---|---|
| GREEN broad (10+ templates) | trades ≥ 20, win_rate ≥ 0.55, mean_edge ≥ $1.00/$100, median_hold ≤ 30, disagreement ≤ 5% | fails: trades, edge, hold | fails: trades, edge, hold | fails all |
| GREEN high-edge (3+ templates) | trades ≥ 10, win_rate ≥ 0.60, mean_edge ≥ $2.00/$100, median_hold ≤ 30, disagreement ≤ 5% | fails: trades, edge, hold | fails: trades, edge, hold | fails all |
| YELLOW (1–9 templates qualify) | any template meets GREEN thresholds | 0 templates qualify | 0 templates qualify | 0 templates qualify |

**Reading: RED.** Zero templates meet either GREEN per-template path. This lands in the rubric's RED zone on the strictest reading: "Zero templates meet the GREEN per-template thresholds."

**Which RED interpretation applies.** Reading the rubric's four interpretations (A–D) against what the data actually shows:

- **Not Interpretation A (cost model too pessimistic).** Gross-to-net attrition on the 9 traded fixtures is small. The edge isn't being killed by fees — it's barely there in the gross.
- **Partially Interpretation B (equivalence is stricter than assumed and the remaining universe is too small).** 88 equivalent bilateral sports families is a narrow base; 24 settled is narrower still; only 9 crossed the entry threshold. Mean edge across those 9 is +$0.25/$100. Edge per trade exists and is positive, but is far below the $1.00/$100 floor.
- **Adjacent to Interpretation C (sports may be wrong; try politics).** Out of scope under current pivot guardrails (no A3 audits for politics, no multi-outcome arb model). The data doesn't force this interpretation; it merely leaves it open as the next wedge if sports doesn't recover.
- **Not yet Interpretation D (thesis wrong).** 9 trades is not enough to conclude the thesis fails. The median_hold_days = 55 ceiling failure is as much about *which part of the sports universe is being linked* (season futures, not head-to-head games) as about whether cross-venue edge exists in sports at all.

**Structural constraint that RED will survive more settlements.** Of the 64 currently-unsettled families, NHL regular-season winners resolve late April/May 2026, MLB World Series resolves late October 2026, and soccer league-winners resolve May–June 2026. Even after full settlement this ~triples `trades_simulated`, the median_hold_days gate will **still fail** — these are all season-long futures whose median capital lockup is measured in months, not the rubric's 30-day ceiling. Waiting for more settlements without changing the linker universe is unlikely to lift any template into YELLOW, let alone GREEN.

**Where the actual lever is.** The linker is currently picking up season futures only. Per the Phase G notes (`90-decisions/linker-bugs-phase-g.md` in the knowledge vault), the linker is known to drop many legitimate head-to-head sports pairs. Head-to-head game markets resolve in days, not months, and would naturally drive median_hold_days down under the rubric ceiling. Expanding the linker to capture H2H markets is the one within-sports move that could plausibly produce a YELLOW reading on a later backtest without violating pivot guardrails.

## Action map (prioritized)

1. **Accept the RED reading as delivered and decide next pivot move.** The backtest has done its job: it surfaced a ledger-grade answer about the current coverage's edge. The answer is RED. The two paths inside the pivot's guardrails are:
   - **Linker expansion to H2H games** — within sports, doesn't violate the "no category expansion / no new providers" rules, and is the only move that can plausibly lift any template over median_hold_days ≤ 30.
   - **Stop and declare.** Publish the RED reading, close the pivot phase, and let the owner decide whether the next phase is linker expansion, a politics-scoped repeat of A1–A5, or one of Interpretation C/D's deeper framing changes.

2. **No parameter re-tunes proposed.** This run does not argue for a threshold change. Tuning parameters to inflate the scoreboard would be the overfitting trap the A5 brief calls out. Every parameter remains at phase-plan defaults.

## Step 11 gate status (post-audit rerun)

| check | result |
|---|---|
| `node --test test/backtest/` (69 tests) | pass |
| Backtest runs end-to-end | pass |
| Three artifacts at fixed paths | pass |
| Fixtures CSV = 1 header + 88 rows | pass |
| meta.json has all 16 spec keys | pass |
| Second run byte-identical CSVs | pass (`diff` empty; only `created_at` changed) |
| No `#` comment lines in CSV bodies | pass (0 in each) |
| Spot-check one traded row for direction / cheap_state / exp_state / void_refund_model / entry_threshold_used / snapshot_interval_ms | pass |
| Family 3218 resolves correctly (cheap_state=won, exp_state=lost, net ≈ $0.16) | **pass** |
| No template shows `disagreement_rate > 0` | **pass (both scored templates at 0)** |

## Upstream fixes landed this session

**1. Polymarket snapshot backfill** — `lib/backfill/polymarket-snapshot-recovery.mjs` + `scripts/backfill/polymarket-snapshot-recovery.mjs`. Fetches from CLOB `/prices-history` at both daily (`fidelity=1440`) and minute (`fidelity=60`) fidelities, merges, and idempotently inserts into `pmci.provider_market_snapshots` via anti-join `WHERE NOT EXISTS`. One-shot run inserted ~56,000 snapshots across all 88 bilateral Polymarket pmids. The observer path is unchanged — this is a re-runnable historical-recovery tool, not a replacement for live ingestion.

**2. Leg-resolver patch** — `lib/backtest/leg-payout.mjs::polyLongYesPays` now handles literal `"Yes"`/`"No"` outcomes before the ref/team fallbacks. Locked in by 5 new regression tests. Unblocks correct resolution for all futures/championship markets.

## Open questions for any next run

- Does the linker currently write snapshots for head-to-head sports game markets (not season futures)? If not, the expansion path for YELLOW starts there.
- Once more families settle (NHL finals ~May 2026, MLB World Series ~late Oct 2026), does a re-run tighten the RED reading or leave room for a second pass? Even with ~3× more trades the median_hold_days gate is unlikely to clear.
- Is there value in running a politics-scoped pivot now (A3 for politics + multi-outcome arb model + backtest) while sports settles the rest of the year? This is Interpretation C territory and out of scope under current guardrails.
