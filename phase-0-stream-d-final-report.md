# Stream D — Final Report (mm-runtime v1 patch)

## Branch

- **Name:** `phase-0/stream-d-mm-v1-patch`
- **Tip (verify after pull):** `git fetch origin && git log -1 --oneline origin/phase-0/stream-d-mm-v1-patch`

## Commits on branch not in `origin/main`

```
2ab1a34 docs(phase-0): correct HEAD SHA in stream-d final report
4f62c90 docs(phase-0): Stream D final report + verification evidence
b0189d6 feat(mm): Stream D — VPIN, game-state gate, IProtection ladder, paper mode
```

## New / materially changed modules under `lib/mm/`

| Path | Role |
|------|------|
| `lib/mm/compute-quote.mjs` | Facade: A-S fair + quote decision |
| `lib/mm/fair-value/avellaneda-stoikov.mjs` | A-S kernel (reservation / half-spread) |
| `lib/mm/toxicity/vpin.mjs` | VPIN core (pure) |
| `lib/mm/gates/vpin-context.mjs` | VPIN pull window + trade ingestion helpers |
| `lib/mm/gates/game-state.mjs` | NBA play-by-play pull gate (dWP/dt) |
| `lib/mm/gates/hoopR-coefficients.json` | Win-probability coefficient snapshot |
| `lib/mm/risk/budget-checker.mjs` | `adjustCandidate` + protection compose |
| `lib/mm/risk/protections/IProtection.mjs` | Base class |
| `lib/mm/risk/protections/MaxDrawdownLadder.mjs` | Global drawdown ladder |
| `lib/mm/risk/protections/CooldownAfterOneSidedFills.mjs` | Same-side fill streak lockout |
| `lib/mm/risk/protections/PerMarketLossCap.mjs` | Per-market loss cap |
| `lib/mm/risk/protections/LatencyGate.mjs` | WS lag gate |
| `lib/mm/risk/protections/KillSwitchOnDailyLoss.mjs` | Daily loss → kill event |
| `lib/mm/orchestrator.mjs` | Pre-place: VPIN, game-state, protections, paper path |
| `lib/mm/kalshi-env.mjs` | `paper` run mode + `isPaperModeEnabledFromEnv()` |
| `lib/mm/order-store.mjs` | Paper `mm_orders` insert + payload `mm_mode` |

**Also:** `scripts/mm/paper-smoke.mjs`, `scripts/mm/run-mm-orchestrator.mjs` (paper exit guard), tests under `test/mm/property/`, `test/mm/integration/`, `test/mm/fixtures/`, `test/mm/compute-quote-refactor.test.mjs`.

## Property + integration tests (verbatim summary)

Command: `node --test test/mm/property/*.test.mjs test/mm/integration/*.test.mjs`

```
✔ 3c fair vs mid logs taker_on_conviction_v2_skipped shape (1.652583ms)
✔ three same-side fills in 5min → cooldown (1.190541ms)
✔ daily loss breach fires halt + kill event hook (2.13375ms)
✔ -3% drawdown → halt from MaxDrawdownLadder (1.128917ms)
✔ dWP/dt helper matches fixture-shaped actions (0.728625ms)
✔ gameStatePullCheck uses fetch mock (1.464042ms)
✔ latency spike triggers protection (cooldown / pull) (1.145708ms)
✔ VPIN spike pulls quotes for 60s window (0.739584ms)
✔ rodlaf bug 1: inventory skew sign vs mid (0.62275ms)
✔ rodlaf bug 1: fixture mid series stable (0.303583ms)
✔ rodlaf bug 2: half-spread positive for random valid states (0.828209ms)
✔ rodlaf bug 3: sigma estimator in [0.05, 0.15] for synthetic and fixture (0.798375ms)
✔ rodlaf bug 4: narrow-spread market scores higher ceteris paribus (0.86725ms)
✔ rodlaf bug 5: MVE / scalar blocklist ∩ rotator selections is empty (2.24775ms)
✔ rodlaf bug 6: per_trade × max_concurrent_positions ≤ total_capital × 0.5 (0.605708ms)
ℹ tests 15
ℹ suites 0
ℹ pass 15
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 207.401916
```

**Full `test/mm` suite:** `node --test 'test/mm/**/*.test.mjs'` → **204 passed**, 0 failed (~95s).  
**Note:** Repo default `npm test` still runs `test/routes/signals.test.mjs` (live API); failures there are **unrelated** to Stream D.

## Paper-mode smoke (2h requirement)

**Prompt acceptance:** ≥1 VPIN gate fire, ≥1 IProtection gate fire, zero orchestrator exceptions, **duration 2h**.

**Executed in agent environment:** short verification run only (`--duration=15000`), not the full 2h run.

**Summary line (15s sample):**

```json
{"event":"paper_smoke_summary","durationMs":15000,"jsonl":"/Users/jaylenjohnson/prediction-machine/scripts/mm/paper-smoke-output/2026-05-09T05-47-50-332Z.jsonl","counts":{"vpin":0,"game":0,"iprot":0,"paper":8,"exc":0,"ticks":3}}
```

- **exc:** 0  
- **VPIN / IProtection in sample:** 0 (expected over longer runs or stressed markets)

## Out-of-scope diff check

```bash
git diff origin/main..HEAD -- scripts/mm/rotate-demo-tickers.mjs deploy/fly.mm.toml supabase/functions/pmci-job-runner/
```

**Output line count:** `0` (no changes).

## Demo-mode grep note

Pre-existing `demo` references remain in e.g. `lib/mm/kalshi-env.mjs` (default env fallback), `scripts/mm/rotate-demo-tickers.mjs`, and `scripts/mm/backfill-mm-fills-fees.mjs`. **Stream D did not touch** rotator / Fly / job-runner; no new demo-only code paths were added for Stream D.

## Status

**BLOCKED ON:** Operator **2h** `MM_RUN_MODE=paper` + `MM_PAPER_MODE_ENABLED=true` run per prompt §VERIFICATION to confirm ≥1 VPIN and ≥1 IProtection in live logs (plus §7 pre-arm checklist before any capital / deploy).  

**READY:** Code + tests merged on `phase-0/stream-d-mm-v1-patch`, branch **pushed** to `origin`; **no PR opened**; **no Fly deploy**.
