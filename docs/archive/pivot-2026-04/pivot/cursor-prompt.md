# Cursor Prompt — PMCI Pivot to Realized Edge

_Copy the block below into Cursor. Assign each lettered agent (A1, A2, A3, A5) to a separate parallel Cursor agent. A4 is an owner task and is not assigned to Cursor._

---

```
You are one of several parallel agents executing a strategic pivot on the PMCI (Prediction Machine) project. The pivot reframes two years of infrastructure work around a single question: can this project produce realized net edge trading cross-venue between Kalshi and Polymarket, at $5k–$25k capital, on a path to $5k+/month P&L?

Before doing anything else, read these three files in order:

1. docs/pivot/north-star.md — the only scoreboard that counts. Every agent reads this first.
2. docs/pivot/dependency-map.md — what runs in parallel, what is on the critical path, what is explicitly out-of-scope.
3. docs/pivot/success-rubric.md — how the final output will be interpreted. Understanding this shapes every upstream decision.

Then read your agent brief:

- Agent A1 → docs/pivot/agents/a1-resolution-ingestion.md (critical path — blocks A5)
- Agent A2 → docs/pivot/agents/a2-cost-model.md (parallel, no dependencies)
- Agent A3 → docs/pivot/agents/a3-resolution-equivalence-audit.md (parallel, no dependencies)
- Agent A5 → docs/pivot/agents/a5-backtest-engine.md (runs after A1 lands; may scaffold earlier with mocks)

Your brief tells you WHY the work matters, what DONE looks like, what is OUT of scope, and what to ESCALATE rather than silently handle. It deliberately does not tell you HOW — that's your judgment. Ask the owner if scope is unclear.

Hard rules that apply to every agent:

- Do not expand scope. If you think you should, escalate.
- Do not touch E2 (crypto), E3 (economics), or any new provider. Those are explicitly out-of-scope.
- Do not tune classifier / matcher / proposer / slot code. That lever was already disproven for this pivot.
- Do not clean up the wider docs/ folder. Only docs/pivot/ is in scope for documentation during the pivot.
- Do not merge to main until your output integrates with the pivot scoreboard (the ranked family P&L table produced by A5).
- When in doubt, re-read north-star.md. If the work does not move the scoreboard, it is out of scope.

Project context you should assume:

- Repo: prediction-machine (Node/Fastify backend, Supabase, Fly.io deploys).
- Supabase project ref: awueugxrdlolzjzikero (use directly with Supabase MCP).
- Current state: 1.4M+ snapshot rows, ~108 bilateral sports families, 0 realized trades, 0 settled-outcome records.
- Active invariants in prediction-machine/CLAUDE.md — some may need scoped exceptions; read your brief for guidance.
- Read db-schema-reference.md before any DB queries.

Your first action after reading the four files above: post a short plan (5–10 bullets) of what you will do, what you will touch, and what you will NOT touch. Get owner confirmation before starting substantive work. No silent work.
```

---

## Suggested Cursor agent launch order

1. Kick off **A1, A2, A3** simultaneously as three parallel agents. A4 is an owner task running in calendar-time alongside.
2. When **A1 reports "outcomes table populated with initial sports coverage"**, launch **A5** with access to A1's output. A5 can begin earlier with mocks if you want an engine ready to plug into real data.
3. When A5 produces its first full run and interpretation document, bring the output to the owner and apply `success-rubric.md` together.
4. Only after that interpretation call: decide on live pilot (Phase H), narrow expansion within sports (YELLOW action), or reframe (RED action).

## Reminder

The point of this setup is not speed for its own sake. It is to force every agent to optimize the same scoreboard. Parallelism without a shared north-star reproduces the 88 → 104 failure mode. With these docs, each agent has the same definition of success and the same list of things not to touch.
