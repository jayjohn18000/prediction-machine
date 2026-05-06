# Rotator 3-nit fixes — 2026-05-06

## TASK

Three surgical fixes on top of the just-merged `mm/rotator-events-endpoint-2026-05-06` work. Each is its own commit on a NEW branch `mm/rotator-3-nits-2026-05-06`. Push the branch. **Do NOT merge to main** — operator review gate.

Branch base: `main` (after merging mm/rotator-events-endpoint-2026-05-06). If that hasn't merged yet, base off `mm/rotator-events-endpoint-2026-05-06` and rebase to main later.

## CONTEXT

Audit of the just-shipped events-pipeline rotator surfaced three issues. Two cosmetic + behavioral, one strategic. None are blockers but all three should ship before Saturday's MLB series goes auto-rotated.

---

## FIX #1 — Game-time-aware rotator selection

**Problem:** the rotator filters/scores markets by `close_time`, but for sports games on Kalshi, `close_time` = settlement (3 days after game end), not game-end. Today's dry-run selected `KXMLBGAME-26MAY061310TORTB-TB` even though that game started 6 hours ago and is already over. We'd be MM-quoting against a settled book.

**Fix:** parse the game start time from the ticker prefix and reject markets whose game has already ended (with a buffer for in-progress games).

Ticker patterns to support:
- `KXMLBGAME-26MAY061310TORTB-TB` → `26MAY061310` = 2026-05-06 13:10 UTC
- `KXMLBTOTAL-26MAY061410LADHOU-9` → 14:10
- `KXMLBSPREAD-26MAY061310TORTB-TB2` → 13:10
- `KXNBAGAME-26MAY09OKCLAL-LAL` → no time = NBA series (not a single game)
- `KXNHLSERIES-26MINCOLR2-COL` → no time = NHL series
- `KXNCAABBGAME-26MAY061730WIENCT-WIE` → 17:30
- `KXNFLGAME-...` similar pattern

Implementation (in `scripts/mm/rotate-demo-tickers.mjs`):

1. Add an exported helper `parseGameStartFromTicker(ticker)` that returns a `Date` object or `null`. Regex: `/^KX[A-Z]+(?:GAME|TOTAL|SPREAD|HIT|HR|GOAL|RUNS)-(\d{2}[A-Z]{3}\d{2}\d{4})/`. The captured group `YYMMDDHHMM` decodes as 2-digit year + 3-letter month + day + 4-digit time. Use UTC.
2. Add a `MM_ROTATOR_GAME_END_BUFFER_HOURS` env (default `4`). Sports games typically end within 3-4 hours of start (NBA ~2.5h, MLB ~3.5h, NHL ~2.5h, NCAA bball ~2h). After `gameStart + buffer`, the market is in settlement, not live.
3. In the candidate filter (after score computation, before diversification cap), reject any market where `gameStart` is non-null AND `gameStart + buffer` is in the past. Tag the rejection reason as `game_already_ended`.
4. Markets where `parseGameStartFromTicker` returns `null` (series-level tickers like KXNBASERIES, crypto monthlies) are NOT affected — they pass through as before.
5. Log how many were filtered: `[rotator] events path: filtered N tickers as game_already_ended`.

Tests (in `test/mm/rotator-events-fetch.test.mjs` or a new file):
- `parseGameStartFromTicker("KXMLBGAME-26MAY061310TORTB-TB")` returns `Date('2026-05-06T13:10:00Z')`
- `parseGameStartFromTicker("KXNBASERIES-26LALOKCR2-LAL")` returns `null`
- `parseGameStartFromTicker("KXMLBTOTAL-26MAY061410LADHOU-9")` returns `Date('2026-05-06T14:10:00Z')`
- A market whose game ended >4h ago is rejected with reason `game_already_ended`
- A market whose game starts in 2h is not rejected
- A market currently in progress (game started 1h ago) is not rejected
- Series-level tickers (no parseable game time) are not rejected

Commit: `feat(mm-rotator): filter ended-game markets via parsed ticker game-time`

---

## FIX #2 — `rotator_source` reflects actual run mode

**Problem:** `ensureProviderMarketRow` hardcodes `metadata.rotator_source: "kalshi-demo"` even when `MM_RUN_MODE=prod`. Misleading metadata in `provider_markets.metadata`.

**Fix:** plumb `runMode` through and emit `"kalshi-prod"` or `"kalshi-demo"` accordingly.

1. `ensureProviderMarketRow` already accepts a `linkRestBase` parameter. Add a second optional param `runMode` (default `"demo"` for back-compat). Use it to set `metadata.rotator_source = \`kalshi-${runMode}\``.
2. Pass `runMode` through from the caller `runRotation` (which already has `runMode` in scope).
3. Single-line test in `test/mm/rotator-events-fetch.test.mjs`: invoke a mocked `ensureProviderMarketRow` with `runMode='prod'` and assert metadata.rotator_source.

Commit: `fix(mm-rotator): rotator_source metadata reflects MM_RUN_MODE`

---

## FIX #3 — 429 backoff jitter (avoid thundering herd)

**Problem:** When multiple concurrent workers hit 429 in lockstep, they all back off `1000ms`, then all retry simultaneously, then all 429 again. Today's dry-run showed multiple KXATP/KXWTA Rome tickers retrying within ms of each other.

**Fix:** apply jitter to the backoff delay in BOTH 429 sites.

Touch points (both already in `rotate-demo-tickers.mjs`):
1. `fetchAllOpenMarkets` (legacy `/markets` path) — the `backoffMs = 1000 * Math.pow(2, attempt - 1);` line.
2. `fetchOpenMarketsViaEvents` — both inner functions: `fetchJsonWith429Retry` AND `fetchMarketDetail` have backoff sites.

Replace each `const backoffMs = base * Math.pow(2, attempt - 1);` with:
```js
const baseMs = Number.parseInt(process.env.MM_ROTATOR_429_BACKOFF_BASE_MS ?? "1000", 10);
const jitter = 0.8 + Math.random() * 0.4; // ±20%
const backoffMs = Math.round(baseMs * Math.pow(2, attempt - 1) * jitter);
```

(`MM_ROTATOR_429_BACKOFF_BASE_MS` already exists per commit `8fbaaa7`. Just add the jitter.)

Test: in `test/mm/rotator-events-fetch.test.mjs`, the existing 429-retry tests can be extended to assert that two concurrent 429s observed in the same retry attempt produce DIFFERENT delay values. Use a stub `Math.random` to make the test deterministic if needed.

Commit: `fix(mm-rotator): jitter 429 backoff to avoid thundering herd`

---

## REPO INVARIANTS (do NOT violate)

- **PROD-only since 2026-05-02.** Don't add DEMO-fallback code paths.
- **No changes to score/diversification/blocklist logic** — only the 3 fixes above.
- **No deploy.** Operator deploys after review.
- **Don't touch the operator's currently-active `mm_market_config` rows** (markets 6059024–6059031 are tonight's manually-seeded MLB games).

## DONE WHEN

- Branch `mm/rotator-3-nits-2026-05-06` pushed to origin with 3 commits.
- All existing tests pass (`node --test test/mm/rotator-events-fetch.test.mjs test/mm/rotate-demo-tickers-prod-mode.test.mjs test/mm/rotate-demo-tickers-validator.test.mjs`).
- New tests for parseGameStartFromTicker pass.
- `npm run verify:schema` PASS.
- Live dry-run shows ≥3 selected tickers AND no game_already_ended tickers in `selected[]`. Log:
  ```
  MM_RUN_MODE=prod MM_ROTATOR_DRY_RUN=1 MM_ROTATOR_TARGET_COUNT=10 MM_ROTATOR_MIN_CLOSE_HOURS=2 \
    node scripts/mm/rotate-demo-tickers.mjs 2>&1 | tail -50
  ```
  Paste the output in your Final Report.
- Final Report posted in chat.

## FINAL REPORT (mandatory)

```
## Rotator 3-Nit Fixes — Final Report

### Branch
mm/rotator-3-nits-2026-05-06 @ <head SHA>
Pushed: yes/no

### Commits
- <SHA>  feat(mm-rotator): filter ended-game markets via parsed ticker game-time
- <SHA>  fix(mm-rotator): rotator_source metadata reflects MM_RUN_MODE
- <SHA>  fix(mm-rotator): jitter 429 backoff to avoid thundering herd

### Files changed
<path:line stat>

### Live dry-run output (post-fix)
<paste tail; verify selected[] contains zero game_already_ended candidates>

### Tests
verify:schema: PASS/FAIL
existing tests: PASS/FAIL
new game-time tests: PASS/FAIL (X cases)
jitter test: PASS/FAIL

### Anomalies
<bullets>

### Operator follow-ups
1. Review + merge mm/rotator-events-endpoint-2026-05-06 + mm/rotator-3-nits-2026-05-06.
2. Deploy: fly deploy --config deploy/fly.api.toml --remote-only
3. Watch first scheduled rotator cron fire post-deploy: confirm selected_count >= 5 and no game_already_ended in selected list.
```

## NOTES FOR YOU (Cursor agent)

- Today is 2026-05-06; tonight's MLB games (08-side from 18:40Z) are still going. Your dry-run should show those as candidates if they're allowed (game ends 4h after first pitch = ~22:40Z), but should reject games that started before ~14:40Z.
- The just-merged events-pipeline rotator selected `KXMLBGAME-26MAY061310TORTB-TB` (13:10Z game) — that's the canary. After your fix, that ticker should be in `rejected[]` with reason `game_already_ended`.
- For testability, keep the buffer hours configurable via env (don't hardcode 4 in the function body — use the env-resolved value).
