# North Star — PMCI Pivot to Realized Edge

_Last updated: 2026-04-19_
_Owner: Jay_
_Status: authoritative. Every agent working on the pivot reads this file first._

---

## The only scoreboard that counts

**A successful pivot produces a ranked list of cross-venue market families (Kalshi ↔ Polymarket) where backtested net edge — after fees, slippage, and capital-lockup cost, on resolution-equivalent pairs — clears a threshold that, at $5k–$25k deployed capital, is on track to clear $5k/month in realized P&L.**

Nothing else counts as progress. Not linked family count. Not coverage breadth. Not classifier accuracy. Not ingestion throughput. Not schema cleanliness.

If a proposed piece of work does not move the system closer to producing that ranked list (or, later, acting on it), it is out of scope for this pivot.

## Why this is the scoreboard

The PMCI project has been stuck optimizing proxy metrics — families linked, proposals accepted, coverage percentage — without ever converting those into a realized dollar. The roadmap (`docs/roadmap.md`) always said the real milestones were Phase F (tradability modeling), Phase G (paper trading), and Phase H (live pilot). Those phases never started. Every improvement until now has been upstream of the question "does any of this actually make money."

The pivot re-centers the entire project on answering that question, on the existing linked-family set, before doing anything else.

## The strategic posture

**Edge quality over coverage.** More families linked is worth zero if none of them clear net edge. A smaller, trusted set of families that reliably produce realizable edge after execution costs is the entire product. Coverage growth is a lever we may pull later — but only *after* we have proof that at least one family type clears the bar, and only *toward* families that resemble the winners.

**Resolution equivalence is non-negotiable.** A "match" between Kalshi and Polymarket on the same underlying event is not real if the two venues resolve on different sources or criteria. A family with non-equivalent resolution will realize losses on disagreement cases no matter how tight the spread looks in snapshots. Families that fail the resolution-equivalence check are excluded from the scoreboard, full stop.

**Historical backtest beats live shadow.** We already have 1.4M+ snapshot rows of bilateral prices. A backtest over that history, against real settled outcomes, is faster, cheaper, and produces the same decision-quality information as a months-long live-shadow paper trader. Phase G (as originally written) gets compressed into a backtest.

## Working assumptions (reviewable)

These are working numbers for the pivot. They are not sacred. The backtest output will tell us which ones to revise.

| Parameter | Working value | Notes |
|---|---|---|
| Minimum net edge per $100 deployed | **$1.00 (1.0%)** default | The right number depends on trade frequency, edge count, and cost-model accuracy. Rubric (`success-rubric.md`) defines how to re-tune post-backtest. |
| Monthly net P&L floor to call the pivot successful | **$5k/month** | "Significant" starts here per owner. More is better. Scoreboard should be interpretable at multiple capital / frequency levels. |
| Planned pilot capital | **$5k–$25k** | Determines whether theoretical edge is large enough at realistic capital to hit the P&L floor. |
| Category in scope | **Sports (first), then possibly politics** | Sports has the most linked families (~108 bilateral as of 2026-04-19), strict-audit GREEN, and bilateral prices flowing. Politics is the second candidate only if sports falls short. |
| Categories explicitly OUT of scope | **Crypto (E2), Economics (E3), any new provider** | See `out-of-scope.md` equivalents in `dependency-map.md`. |

## What "done" looks like for the pivot

The pivot is complete when the following artifacts exist and are trustworthy:

1. A `market_outcomes` dataset covering every closed market in every currently-linked sports family, with the winning outcome ingested from each provider.
2. A resolution-equivalence audit CSV that classifies each of the ~108 sports families as `equivalent`, `non_equivalent`, or `ambiguous`, with both sides' resolution rules recorded.
3. A documented fee + slippage cost model (`lib/execution/costs.mjs` or similar) with explicit, reviewable assumptions.
4. A backtest script that, for each `equivalent` family, walks historical snapshots, identifies spread-exceeds-threshold entry points, simulates both legs held to resolution, and emits per-family realized net P&L.
5. A ranked output table: family, trade count, win rate, mean net edge per $100, total P&L over history, time-to-resolution distribution.
6. A go/no-go decision on a guarded live pilot (Phase H) based on (5) — interpreted through `success-rubric.md`.

When those six exist, the pivot is done. The next chapter is either "run the live pilot" or "the edge isn't there and we re-scope."

## What we are NOT doing during the pivot

- Onboarding new providers (DraftKings, Manifold, Myriad, Limitless, Metaculus, PredictIt)
- Extending ingestion to crypto or economics categories
- Further classifier / matcher / proposer tuning on unlinked-slot coverage
- Cleaning up the wider `docs/` folder or the older `prediction-machine/` code layers
- Building the full Phase F tradability platform as a platform (we build the minimum needed to produce one net-edge number per family, not all nine sub-items)
- Building a live shadow-trade paper trader (replaced by historical backtest)

If one of these becomes genuinely necessary, it's scoped as a follow-on chapter *after* the backtest decision, not in parallel with it.

## North-star check for any proposed work

Before starting any task, the agent (or human) asks:

1. Does this move us closer to producing the ranked family P&L table?
2. Or does it unblock the live pilot decision after the ranked table exists?
3. If neither, why is it on the critical path right now?

If the answer to (3) is "because it's on the roadmap" or "because it was the current milestone" — that's a drift signal. Stop, re-read this file, and redirect.
