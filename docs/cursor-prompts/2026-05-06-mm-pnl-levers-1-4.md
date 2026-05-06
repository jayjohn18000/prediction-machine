# MM PnL Levers 1–4 — mid-clock optimization (2026-05-06)

## TASK

Ship four PnL-optimization levers for the active ADR-012 PROD 7-day clock (currently hour 90 of 168 — clock continues to T+168 = 2026-05-09T22:37Z). The clock is already RECORDED-FAIL on ADR-013-reframed uptime criterion (46.41% uptime); these changes are aimed at back-half PnL improvement and at gathering tuning data for the next clock under ADR-014. Do not block on perfection.

Branch: `mm-pnl-levers/2026-05-06`. Commit each lever as its own commit on this branch. Push the branch. **Do NOT merge to main** — operator review gates merge.

## CONTEXT — why these levers

PnL diagnostic at hour 90 (across 253 fills since T0):
- spread_capture +328c · adverse −157c · fees −244c · inv_drift −16c · **net = −89c**
- Two markets (5113193 + 5113194, both TORCLE NBA totals from day 2) account for −307c. Without them, net = +218c.
- 38% of fills profitable (sum +346c), 28% killer adverse (sum −420c) — fat left tail, not a strategy-wide failure.
- `pmci.mm_fills.kalshi_trade_fee_cents` and `kalshi_rebate_cents` are NULL on all 258 fills since T0; only `kalshi_net_fee_cents` populated (Track M writer regression — see lever #2).

Levers, in priority order:

1. **Tighten `toxicity_threshold` 200 → 100.** Live data shows the 200 threshold didn't fire on TORCLE markets that bled −2c avg adverse for hours. 100 is calibrated to the live signal. Already applied via SQL UPDATE on existing enabled rows; this commit makes it the rotator default so future cycles inherit it.
2. **Verify `post_only` flag on Kalshi order placement.** If we're crossing the spread (taker), we're paying full Kalshi fees. Maker quotes earn rebates. Fee data is missing component breakdown so we can't tell from data — needs code inspection + (if missing) a wiring fix.
3. **Rotator `min_close_hours` 4h → 8h.** Markets within 4h of close exhibit settlement-direction info-asymmetry — the TORCLE-199 disaster was the last hour before NBA close. Pushing the floor to 8h excludes the most toxic window.
4. **Adverse-selection branch in `mm-rotator-disable-watcher`.** The current 5-min watcher auto-blocklists by reject rate. It missed TORCLE because we got filled at toxic prices, not rejected. Add an adverse-selection trigger: if rolling 1h `AVG(adverse_cents_5m)` on a market < −1.5c with ≥10 fills in window, INSERT into `pmci.mm_ticker_blocklist` with reason='high_adverse_selection' (24h expiry).

## REPO INVARIANTS (do NOT violate)

- **PMCI is PROD-only since 2026-05-02 ADR-012.** Never invoke rotator or runtime in DEMO. If a PROD path errors, fix the PROD path; never fall back to DEMO. The script filename `scripts/mm/rotate-demo-tickers.mjs` is historical — it handles both modes via env, default PROD.
- **Single-instance MM.** Do not change `pmci-mm-runtime` deploy scaling. `fly scale count 1` is required.
- **Depth-sub structural bug is NOT in scope.** The 35h gap that broke the clock is caused by the orchestrator's WS depth subscriber not rebuilding when the rotator changes the universe mid-run. That's the highest-priority post-clock fix but explicitly out of scope here — a separate branch/PR.
- **`active markets only` for observer/proposer** — don't extend code that touches historical/settled markets except via existing `lib/resolution/` paths.
- **Cron writer Pattern 4:** any cron change must include the validation SQL that proves rows are landing, in the same commit as the cron migration.
- **`MM_RUN_MODE=prod` is set on BOTH `pmci-api` AND `pmci-mm-runtime`** — do not assume one inherits from the other.
- **Migrations:** apply additive DDL via Supabase MCP `apply_migration`. Do not run destructive DDL.

## DELIVERABLES (per lever)

### Lever #1 — Default `toxicity_threshold = 100` on rotator-managed rows

Files:
- `scripts/mm/rotate-demo-tickers.mjs` — find `DEFAULT_MM_PARAMS_PROD` (or equivalent constant) and change `toxicity_threshold` to `100`. If there's a DEMO equivalent, update to match — or leave DEMO alone if you can confirm DEMO defaults are gated separately.
- Search for any other consumers of the prior `200` default and update consistently.

Note: I (operator) am applying the SQL UPDATE on currently-enabled rows directly via Supabase MCP. Your code change is for **future** rotator cycles to inherit the new default.

Verification:
```bash
grep -n "toxicity_threshold" scripts/mm/ lib/mm/ --include="*.mjs"
# All rotator-default references should show 100, not 200
```

Commit message: `feat(mm): tighten DEFAULT_MM_PARAMS_PROD.toxicity_threshold 200→100`

### Lever #2 — Verify and (if needed) wire `post_only` on Kalshi order placement

Steps:
1. Read `lib/mm/orchestrator.mjs` and `lib/providers/kalshi.mjs` (or `lib/providers/kalshi-trader.mjs` — whichever owns order POST). Find the order-creation request body.
2. Check whether the Kalshi `/portfolio/orders` POST body includes `post_only: true` (or equivalent maker-only flag). The Kalshi REST docs use `post_only` boolean on `CreateOrder`.
3. **If absent:** add it. All MM orders should be post-only — if a quote would cross the inside book at place time, we want it rejected, not filled at taker price.
4. **If already set:** add a one-line code comment confirming where it's set, and note in the Final Report that no change was needed.
5. Independently, check `lib/mm/post-fill-backfill.mjs` (or wherever fee writer lives — the writer that populates `mm_fills.kalshi_*_fee_cents`): is it populating `kalshi_trade_fee_cents`, `kalshi_rounding_fee_cents`, and `kalshi_rebate_cents` from the Kalshi fill payload? Live evidence: 0 of 258 fills have non-null trade/rebate. Only `kalshi_net_fee_cents` is being written. **Fix the writer to populate all four columns** — the Kalshi fill response contains them per the API contract.

Verification:
```bash
# Confirm post_only is in the create-order request body
grep -rn "post_only" lib/ src/ scripts/ --include="*.mjs"
# Should appear in the order-create call site

# After deploying — wait ~10 min, query a fresh fill
# psql output should show non-null kalshi_trade_fee_cents on fills observed_at > <deploy ts>
```

Commit message (split into two if helpful):
- `fix(mm): set post_only=true on Kalshi order placement`
- `fix(mm): populate kalshi_trade_fee_cents + _rebate_cents in fill writer`

### Lever #3 — Rotator `min_close_hours` 4h → 8h

Files:
- `scripts/mm/rotate-demo-tickers.mjs` — find the constant (likely `MIN_CLOSE_HOURS` / `PROD_MIN_CLOSE_HOURS` or env var like `MM_ROTATOR_MIN_CLOSE_HOURS`). Change 4 → 8 (or add the env override default, whichever is the existing pattern).
- If env-driven: also update `deploy/fly.api.toml` and `deploy/fly.mm.toml` to set the new default.

Verification:
```bash
grep -n "min_close" scripts/mm/ lib/mm/ --include="*.mjs"
# All references should show 8h or env-default 8

# Dry-run the rotator (do not write):
node scripts/mm/rotate-demo-tickers.mjs --dry-run --mode=prod
# Output should show selected markets all close > 8h from now
```

Commit message: `feat(mm): rotator min_close_hours 4→8 to exclude near-settle markets`

### Lever #4 — Adverse-selection branch in `mm-rotator-disable-watcher`

The cron watcher currently fires every 5 min and auto-blocklists by reject rate. Add an adverse-selection branch.

Files:
- Find the watcher script (likely `scripts/mm/rotator-disable-watcher.mjs` or similar; or the SQL function the cron calls in `supabase/migrations/`). The cron entry was added in commit `de5fbc3` per memory.
- Add the new check.

Logic:
```pseudo
For each enabled market in pmci.mm_market_config:
  Compute rolling 1h window stats from pmci.mm_fills:
    fills_1h = count(*) where observed_at > now() - 1h
    avg_adv_1h = AVG(adverse_cents_5m) where observed_at > now() - 1h
  If fills_1h >= 10 AND avg_adv_1h < -1.5:
    INSERT INTO pmci.mm_ticker_blocklist (ticker, reason, blocked_at, expires_at, notes)
    VALUES (
      (SELECT kalshi_ticker FROM ... WHERE market_id = mc.market_id LIMIT 1),
      'high_adverse_selection',
      now(),
      now() + interval '24 hours',
      format('auto: 1h avg_adv=%.2fc on %d fills', avg_adv_1h, fills_1h)
    )
    ON CONFLICT (ticker) DO NOTHING;
    UPDATE pmci.mm_market_config SET enabled = false WHERE market_id = mc.market_id;
```

Use the **same idempotent pattern** the existing reject-rate branch uses — don't duplicate logic; if there's a shared helper for "auto-blocklist this ticker for reason X with detail Y", use it.

**Pattern 4 invariant:** the same commit that adds this branch must include the validation SQL in `docs/` (or a comment in the watcher) showing how to verify rows actually land in `mm_ticker_blocklist` after a synthetic adverse market. Recommended SQL:
```sql
SELECT ticker, reason, blocked_at, notes
FROM pmci.mm_ticker_blocklist
WHERE reason = 'high_adverse_selection'
  AND blocked_at > now() - interval '1 hour'
ORDER BY blocked_at DESC;
```

Verification (post-deploy):
- Watch `cron.job_run_details` for the watcher's runs after deploy — confirm `status='succeeded'`.
- After 1 hour with the cron running, query `pmci.mm_ticker_blocklist WHERE reason='high_adverse_selection'`. Empty is fine if no market is currently toxic; non-empty confirms the branch fires.

Commit message: `feat(mm): adverse-selection branch in mm-rotator-disable-watcher`

## OUT OF SCOPE

- Depth-sub rebuild fix (separate branch).
- Inventory skew model (lever #5 from operator's plan; defer to ADR-014 setup).
- Per-market observed-adverse weighting in rotator score (lever #7; defer).
- Killing the 35h gap retroactively. Already accepted in ADR-013.
- Migration secrets rotation (Track B residual). Deferred until clock closes per existing ADR.
- Any change to `pmci-observer` or Polymarket indexer (different workstreams).

## DONE WHEN

- All four levers committed on branch `mm-pnl-levers/2026-05-06`.
- Branch pushed to origin.
- All four commits pass `npm run verify:schema`.
- Lever #2's `post_only` change verified by grep showing the flag in the create-order body.
- Lever #4's watcher change deployed (Supabase Edge function redeploy via `supabase functions deploy pmci-job-runner` if relevant).
- Final Report posted in chat (structure below).

## FINAL REPORT (mandatory)

```
## MM PnL Levers 1–4 — Final Report

### Branch
mm-pnl-levers/2026-05-06 @ <head SHA>
Pushed: yes / no
Merged to main: NO (operator review gate)

### Lever #1 — toxicity_threshold default 200→100
File(s): <path:line>
Status: shipped / not-needed (explain)
Commit: <SHA>

### Lever #2 — post_only + fee-column writer
post_only:
  Was already set: yes / no
  File(s) changed: <path:line>
  Commit: <SHA>
Fee-column writer:
  Trade/rebate columns now populated: yes / no
  File(s) changed: <path:line>
  Commit: <SHA>

### Lever #3 — rotator min_close_hours 4→8
File(s): <path:line>
Dry-run output (selected markets, all close > 8h from now):
  <paste rotator --dry-run summary>
Commit: <SHA>

### Lever #4 — adverse-selection branch in watcher
File(s): <path:line>
Logic anchor (shared helper used / new function):
  <which>
Validation SQL:
  <SQL location>
Cron deploy: yes / no
Commit: <SHA>

### Tests
npm run verify:schema: PASS / FAIL
npm test (touched suites): PASS / FAIL
Any test debt accepted: <list, with rationale>

### Anomalies / open questions
<bullet list — anything you couldn't verify, anything that surprised you in the code>

### Operator follow-ups
1. Apply Lever #1 SQL UPDATE on currently-enabled rows (operator-side; cannot be done on the branch).
2. Review and merge `mm-pnl-levers/2026-05-06` to main when ready.
3. Deploy `pmci-mm-runtime` to pick up post_only / fee-writer changes.
4. (If lever #4 needed Edge function redeploy) confirm `mm-rotator-disable-watcher` cron logs show successful runs after deploy.
```

## NOTES FOR YOU (Cursor agent)

- This is mid-flight. The clock keeps running. Don't break existing functionality. If you discover a code state that contradicts this brief (e.g., post_only is already wired and the fee-writer regression isn't real), say so in the Final Report and skip — don't paper over it.
- If `lib/providers/kalshi.mjs` and `lib/providers/kalshi-trader.mjs` both exist, the trader is the one that actually sends orders.
- The `pmci-job-runner` Supabase Edge function is the home for cron logic; check `supabase/functions/pmci-job-runner/index.ts` for the JOB_MAP entry and the actual handler for `mm-rotator-disable-watcher`.
- Database project ref: `awueugxrdlolzjzikero` for Supabase MCP calls.
