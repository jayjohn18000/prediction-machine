# Dependency Map — PMCI Pivot

_Read `north-star.md` first. This file answers: what runs in parallel, what blocks what, what stays off the table._

---

## The critical path

The pivot has exactly one critical path. Everything on it must be serial. Everything off it should be parallelized aggressively.

```
[A1: Resolution ingestion] → [A5: Backtest engine] → [Go/no-go: live pilot]
```

You cannot build the backtest without settled outcomes. You cannot decide on a live pilot without the backtest. These three points are serial. Minimize their duration; the rest of the plan exists to make sure agents aren't idle while the critical path advances.

## Agents and their parallelism posture

| Agent | Scope | Blocks | Blocked by | Can start |
|---|---|---|---|---|
| **A1 — Resolution ingestion** | Pull settled outcomes from Kalshi + Polymarket for every closed market in a currently-linked sports family. New `market_outcomes` table. | A5 | nothing | **now** |
| **A2 — Fee + slippage cost model** | `lib/execution/costs.mjs` — static fee schedules per venue, v1 slippage estimate. Pure research + one module. | A5 | nothing | **now** |
| **A3 — Resolution-equivalence audit** | CSV of all ~108 sports families classifying each as `equivalent` / `non_equivalent` / `ambiguous`. No code. | A5 (as filter input) | nothing | **now** |
| **A4 — Execution account readiness** | Owner task, not an agent task. Kalshi + Polymarket funded accounts, KYC, API keys that can place orders. Calendar time, not work time. | Live pilot (Phase H) | nothing | **now** |
| **A5 — Backtest engine** | Walks snapshot history, applies entry threshold, simulates both legs to resolution using A2's cost model and A3's equivalence filter, emits ranked per-family P&L. | Go/no-go decision | A1 (hard), A2 (hard), A3 (soft — can start without, must integrate before shipping final) | **after A1 lands** |

**Rule of thumb:** A1, A2, A3, A4 run fully in parallel starting immediately. A5 starts the moment A1's `market_outcomes` table has useful coverage (even a subset of families) and integrates A2 and A3 as they land.

## Why A2 and A3 don't block A5 at start

A5 can be scaffolded against mock outcomes and a stub cost function while A1 is being built. The backtest's *shape* — walking snapshots, detecting entry, computing holding P&L, joining outcomes — can be written and unit-tested with synthetic data. What it cannot produce is a *real* ranked output. That only exists once A1 lands and A2 + A3 are integrated. So A5 can begin earlier than the table suggests, as long as its dependencies are tracked explicitly and it's not merged to main until the real inputs are wired.

## Dependency graph (visual)

```
                    ┌──────────────────────────────┐
                    │  north-star.md (scoreboard)  │
                    └──────────────┬───────────────┘
                                   │
              ┌───────────────┬────┴────┬────────────────┐
              │               │         │                │
              ▼               ▼         ▼                ▼
      ┌─────────────┐ ┌────────────┐ ┌──────────┐ ┌──────────────┐
      │ A1          │ │ A2         │ │ A3       │ │ A4           │
      │ Resolution  │ │ Cost model │ │ Rules    │ │ Exec account │
      │ ingestion   │ │ (fees/slip)│ │ audit    │ │ readiness    │
      └──────┬──────┘ └─────┬──────┘ └────┬─────┘ └──────┬───────┘
             │              │             │              │
             └──────────────┼─────────────┘              │
                            ▼                            │
                    ┌──────────────┐                     │
                    │ A5           │                     │
                    │ Backtest     │                     │
                    │ engine       │                     │
                    └──────┬───────┘                     │
                           │                             │
                           ▼                             │
                    ┌──────────────┐                     │
                    │ Go/no-go     │◀────────────────────┘
                    │ live pilot   │   (A4 only gates if decision = go)
                    └──────────────┘
```

## Explicit out-of-scope (do not start these in parallel)

These are tempting because they look like unfinished business. They are not on the pivot critical path and will divert agent capacity. If an agent naturally reaches toward one of these, it's a drift signal — stop and re-read `north-star.md`.

| Out-of-scope work | Why it's out-of-scope right now |
|---|---|
| E2 crypto ingestion / proposer | Adds a new category with no evidence any existing category makes money. Expansion before validation. |
| E3 economics ingestion / proposer | Same as E2. |
| New providers (DraftKings, Manifold, Myriad, Limitless, Metaculus, PredictIt) | Broader coverage doesn't help if current coverage has no realized edge. Revisit post-backtest if sports shows edge and we want to scale. |
| Classifier / matcher / slot tuning | Phase G reconnaissance already showed ~95% of solo-slot is true coverage gap, not classifier-fixable. Further tuning optimizes the wrong lever. |
| `docs/` folder cleanup outside `docs/pivot/` | The wider docs will get rewritten once the backtest tells us which framing was correct. Tidying them now just produces tidier possibly-wrong strategies. |
| Full Phase F tradability platform (9 sub-items) | We build the minimum subset needed to produce one net-edge number per family. The full platform is premature until edge is proven. |
| Live shadow paper trader (original Phase G) | Replaced by historical backtest against snapshot data. Faster, cheaper, same decision quality. |
| Observer v2 enhancements / frontier improvements | Current observer is sufficient to keep snapshots flowing. Enhancements don't move the scoreboard. |
| UI / dashboard work in `lovable-ui` | A ranked P&L table is a CSV. A UI on top of it is a follow-on chapter, not a prerequisite. |

## Parallelism guidance for Cursor agents

Cursor supports parallel agents with subagents. Use that capacity on A1, A2, A3 concurrently. Suggested subagent split inside each:

- **A1 subagents:** one per provider adapter (Kalshi settlement scraper, Polymarket settlement scraper) + one for the `market_outcomes` schema migration + backfill.
- **A2 subagents:** one for fee research (current published schedules for both venues, as of today), one for slippage model design, one for the `costs.mjs` module.
- **A3 subagents:** split by sport (NBA, MLB, tennis, soccer, etc.) to parallelize the manual rule-reading. Output converges into one CSV.

Do not split A5 into subagents that each optimize a different metric. A5 is one engine producing one ranked table. Subagents there would re-create the divergent-wins failure mode.

## Shared discipline across agents

1. **Every agent reads `north-star.md` before starting.** If a task doesn't map to an artifact in the "done" list, it's out of scope.
2. **Every agent reads its own brief under `docs/pivot/agents/` for scope boundaries.** Briefs are short and focus on *why*, not *how*.
3. **No agent expands scope without owner sign-off.** If an agent discovers real blockers not listed here, it escalates rather than silently widening.
4. **No merging to main until the agent's artifact is integrated with the pivot scoreboard.** An agent producing a great-looking output that doesn't plug into A5 is not done.
