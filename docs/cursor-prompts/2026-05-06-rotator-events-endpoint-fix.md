# Rotator endpoint fix — use /events not /markets — 2026-05-06

## TASK

Replace the rotator's broken `/markets?status=open` candidate fetch with `/events?with_nested_markets=true` filtered to single-game series tickers (KXMLBGAME, KXNBAGAME, KXNHLGAME, KXNCAABBGAME, KXNCAAMBBGAME, KXMLBSPREAD, KXMLBTOTAL, KXNBATOTAL, KXNBASERIES, KXNHLSERIES, KXBTCMAXMON, KXETHMAXMON, KXBTCMINY, KXETHMINY, KXNFL, KXUFC, KXATP, KXWTA, KXPGA, KXF1, KXIPL).

Branch: `mm/rotator-events-endpoint-2026-05-06`. Commit each step as its own commit. Push the branch. **Do NOT merge to main** — operator review gate.

## CONTEXT — why now

Rotator is structurally broken:
- `/markets?status=open&limit=1000` returns ~25,000 markets, but ~95% are KXMVE* multi-game-extended parlay junk with `volume_24h=0`, `yes_bid=0`, `yes_ask=0`.
- The rotator's score = `vol × cat × urg × spread`. With spread=0, score=0 for all parlay junk.
- Real single-game tickers (KXMLBGAME-26MAY061840BOSDET-BOS etc.) have actual prices but get drowned in the parlay flood.
- Live verification (2026-05-06 18:35Z): rotator dry-run with target=15, min_close=2h returned **selected=0, rejected=0** out of 25,000 fetched. The score filter eliminated everything before scoring.

Operator note: this issue was flagged in `docs/system-state.md` 2026-05-03 ("rotator queries `/markets?status=open` (returns mostly KXMVE* parlay junk per lane-12); needs to use `/events?with_nested_markets=true`. Next rotator fire 2026-05-03T09:00 UTC.") — never actually fixed.

Operator manually seeded tonight's MLB games (commit log will show `mm_market_config` UPSERT 2026-05-06 18:30Z) so the system is trading right now. This branch fixes the underlying rotator so Saturday's MLB series day-game and afternoon slate auto-rotate.

## REPO INVARIANTS (do NOT violate)

- **PROD-only since 2026-05-02.** Never invoke rotator with `--mode=demo`. Default mode in this script is PROD.
- **Single-instance MM.** Don't change deploy scaling.
- **Cron Pattern 4.** If your changes affect any cron writer, ship validation SQL in the same commit.
- **No code-path changes for the watchdog branches** — only the candidate-fetch path.
- **The rotator's score / diversification / blocklist logic stays as-is.** Only swap the data source feeding `sortedScored`.

## DELIVERABLES

### Step 1 — Replace candidate fetch in `scripts/mm/rotate-demo-tickers.mjs`

Find the function that fetches `/markets?status=open` (currently around the cursor pagination loop that fetches up to 25,000 markets). Replace it with a function that:

1. **Hits `/events?status=open&limit=200&with_nested_markets=true`** (cursor-paginated).
2. **Filters events** by `series_ticker` matching a configured allowlist:
   ```js
   const ROTATOR_SERIES_ALLOWLIST = [
     // sports — single-game tickers
     "KXMLBGAME", "KXNBAGAME", "KXNHLGAME", "KXNCAABBGAME", "KXNCAAMBBGAME",
     "KXMLBSPREAD", "KXMLBTOTAL", "KXNBATOTAL", "KXNBASERIES", "KXNHLSERIES",
     "KXNFLGAME", "KXNFL", "KXUFC", "KXATP", "KXWTA", "KXPGA", "KXF1", "KXIPL",
     // crypto monthlies + dailies
     "KXBTCMAXMON", "KXETHMAXMON", "KXBTCMINY", "KXETHMINY",
     "KXBTCMAX", "KXETHMAX", "KXBTCDAILY", "KXETHDAILY",
   ];
   ```
   Make this exported as a const so it's testable + tunable via env (`MM_ROTATOR_SERIES_ALLOWLIST` overrides if set, comma-separated).
3. **Flatten `event.markets` into a single list** with all the fields the existing scoring expects (`ticker`, `event_ticker`, `volume_24h_fp`, `yes_bid_dollars`, `yes_ask_dollars`, `close_time`, `open_time`, `category`).
4. **Per-ticker price fetch fallback:** the bulk `/events` endpoint returns markets WITHOUT live prices (verified 2026-05-06: bid/ask/vol all zero in nested markets). After the events filter narrows the universe to ~50-200 candidates, **fetch each ticker individually** via `GET /markets/{ticker}` with a small concurrency limit (default 8 parallel; rate-limit retry on 429 same as existing code) to populate live prices. Cache prices in memory for the rotator run.
5. **Same return shape** as the current candidate gatherer so `computeRotatorScoreFields` and downstream code unchanged.

### Step 2 — Add `MM_ROTATOR_BACKEND` env switch

Default to `"events"` (new path). Allow `"markets"` for fallback to old broken path (debug only). Log which backend was used at the start of the rotator run.

### Step 3 — Update existing tests + add coverage for the new path

- Existing tests in `test/mm/rotate-*.test.mjs` may use mocked `/markets` responses. Update their fixtures.
- Add a new test file `test/mm/rotator-events-fetch.test.mjs` covering:
  - Filters events by series_ticker allowlist (rejects KXMVE*, KXPRESNOMD, etc.)
  - Per-ticker price fetch fallback called when nested prices are zero
  - Concurrency cap respected
  - 429 retry path
  - Empty events list returns empty candidate list (not error)

### Step 4 — Dry-run end-to-end against PROD Kalshi

```bash
MM_RUN_MODE=prod MM_ROTATOR_DRY_RUN=1 \
  MM_ROTATOR_TARGET_COUNT=10 MM_ROTATOR_MIN_CLOSE_HOURS=2 \
  node scripts/mm/rotate-demo-tickers.mjs 2>&1 | tail -60
```

Expected: `selected.length >= 5` with sane MLB/NBA tickers, sensible scores, rejected counts non-zero (some markets fall out on filters but not all). Log the output in the Final Report.

## OUT OF SCOPE

- Changing the score formula.
- Changing the blocklist / watchdog logic.
- Changing `validateTickerForMM`.
- Live-deploy. Operator runs `fly deploy --config deploy/fly.api.toml --remote-only` themselves after merge.
- The fee-writer regression (separate workstream).

## DONE WHEN

- Branch `mm/rotator-events-endpoint-2026-05-06` pushed to origin.
- Each step is its own commit.
- `npm run verify:schema` PASS.
- New test file passes (`node --test test/mm/rotator-events-fetch.test.mjs`).
- Existing rotator tests pass (`node --test test/mm/rotate-*.test.mjs`).
- Dry-run output shows ≥5 selected real single-game tickers with non-zero scores.
- Final Report posted in chat.

## FINAL REPORT (mandatory)

```
## Rotator Events Endpoint Fix — Final Report

### Branch
mm/rotator-events-endpoint-2026-05-06 @ <head SHA>
Pushed: yes/no
Commits: <list with subjects>

### Files changed
<path:line summaries>

### Dry-run output
[paste the tail of the dry-run command — selected count, top 5 candidates with scores, rejected count]

### Tests
verify:schema: PASS/FAIL
existing rotator tests: PASS/FAIL
new rotator-events-fetch tests: PASS/FAIL (X cases)

### Allowlist
<final ROTATOR_SERIES_ALLOWLIST contents — confirm ENV override works>

### Anomalies
<bullets — anything surprising, e.g. Kalshi API returning unexpected shapes, rate-limit thresholds discovered>

### Operator follow-ups
1. Review + merge to main when ready.
2. Deploy: fly deploy --config deploy/fly.api.toml --remote-only
3. First rotator cron run after deploy: confirm `selected_count >= 5` in cron.job_run_details for `pmci-mm-rotate-tickers` or `pmci-mm-rotate-tickers-pre-mlb`.
```

## NOTES FOR YOU (Cursor agent)

- The current `scripts/mm/rotate-demo-tickers.mjs` is ~1000 lines. Read it first, find the `/markets` fetch, and surgically replace just the candidate-fetch step. Do not rewrite the whole file.
- Kalshi `/markets/{ticker}` returns `{market: {...}}` shape (not `markets[]`). Normalize.
- Rate limit: Kalshi public API tolerates ~10 req/sec. Use a 100ms stagger or P-limit-style concurrency=8.
- Verified live data: today (2026-05-06 18:30Z) `/events?with_nested_markets=true` cursor-paginated returns 1600 events incl. 125 sports events. Single-game tickers are nested under series_ticker like `KXMLBGAME` with the format `KXMLBGAME-26MAY061840BOSDET-BOS`.
- Operator has manually seeded 8 MLB tickers tonight (mm_market_config 6059024-31). Don't touch those rows; the rotator should pick fresh ones in subsequent cycles.
- Database project ref: `awueugxrdlolzjzikero` for Supabase MCP.
