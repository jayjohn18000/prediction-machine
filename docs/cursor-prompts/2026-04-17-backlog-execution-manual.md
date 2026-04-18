# PMCI Backlog Execution Manual

Generated: 2026-04-17. This is the executor reference for all backlog items from the April 17 audit session.

---

## Dependency Map

```
[A] Crypto ladder proposer ──────────┐
                                      ├──▶ [D] Economics ladder proposer (same pattern)
[B] Event metadata across categories ─┘
                                           │
[C] Verify cron jobs are firing  ──────────┤  (independent, do anytime)
                                           │
[E] Stale-cleanup cron verification ───────┤  (independent, do anytime)
                                           │
                                           ▼
                                   [F] Status command (depends on nothing, do anytime)
                                           │
                                           ▼
                              [G] Daily status digest Edge Function
                                           │
                                           ▼ (all above complete = Phase E done)
                              ─────────────────────────
                              [H] Context hygiene (do when friction appears)
                              [I] Golden fixtures (do after E, before F starts)
                              [J] Weekly coverage benchmark cron
                              [K] Design: divergence scoring for ladders (Phase F gate)
                              [L] Design: canonical event lifecycle
```

---

## Group 1 — Parallel now (no dependencies between them)

### [A] Crypto ladder proposer — IN PROGRESS
**Prompt file:** `docs/cursor-prompts/2026-04-16-crypto-ladder-grouping.md`
**What:** Rewrite crypto proposer to group by event_ref, match events across venues, propose at event-level and strike-to-strike level.
**Touches:** `scripts/review/pmci-propose-links-crypto.mjs`, `lib/matching/compatibility.mjs`
**Overlaps with:** [B] uses event_ref which crypto ingestion already populates. [D] will copy this pattern.
**Test:** `node scripts/review/pmci-propose-links-crypto.mjs --dry-run --verbose`

### [B] Event metadata consistency across all categories
**What:** Verify and fix that all four ingestion scripts (sports, politics, economics, crypto) store `event_ref` and Polymarket event slug/group ID consistently in both the column and metadata. Crypto and economics already do this. Sports and politics need to be checked — they store `event_ref` but may not store the Polymarket event slug in metadata for later grouping.
**Touches:** `lib/ingestion/sports-universe.mjs`, `lib/ingestion/universe.mjs` (politics)
**Overlaps with:** [A] and [D] depend on `event_ref` being populated. [B] is non-blocking for crypto (already works) but blocking for applying ladder grouping to sports or economics later.
**Test:** Query `SELECT event_ref, metadata->>'market_id' FROM pmci.provider_markets WHERE category = 'sports' AND provider_id = 2 LIMIT 10` and confirm event_ref and slug are present.

### [C] Verify auto-review cron jobs are actually firing
**What:** The migrations for auto-review cron (review:crypto at 8/14/20/2 UTC, review:economics at 6/12/18/0 UTC) are applied. The edge function entries exist in JOB_MAP. But nobody has confirmed these are actually executing. Check `cron.job_run_details` for recent runs and verify the admin-jobs route handlers work.
**Touches:** Nothing — read-only verification. If broken, fix the route handler in `src/routes/admin-jobs.mjs`.
**Overlaps with:** [A] changes the crypto proposer, which is what the review:crypto cron invokes. If [A] is in progress, let it land first before verifying cron.
**Test:** `SELECT jobid, jobname, start_time, status FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;` via Supabase MCP.

### [E] Verify stale-cleanup cron is firing
**What:** Same as [C] but for `pmci-stale-cleanup` (nightly 2am UTC). Migration is applied. Confirm it's actually running.
**Touches:** Nothing — read-only. The stale-cleanup script and admin-jobs route already exist.
**Overlaps with:** Independent of everything else.
**Test:** Same cron.job_run_details query, filter for `pmci-stale-cleanup`.

### [F] Create `npm run pmci:status` command
**What:** Single command that prints: smoke counts (markets/snapshots/families/links), pending proposals by category, observer freshness (latest heartbeat age), and active link counts by category.
**Touches:** New script `scripts/pmci-status.mjs`, add npm script to `package.json`.
**Overlaps with:** [G] will use the same queries. Write the SQL once, reuse it.
**Test:** `npm run pmci:status` prints a readable one-screen summary.

---

## Group 2 — After Group 1 (has dependencies)

### [D] Economics ladder proposer
**What:** Apply the same event-level grouping pattern from [A] to the economics proposer. Fed decisions have similar ladder structure (multiple rate-hike levels per meeting).
**Depends on:** [A] landing and being validated. Copy the pattern, adapt the prefilter.
**Touches:** `scripts/review/pmci-propose-links-economics.mjs`
**Overlaps with:** Uses same `event_ref` grouping as [A]. The economics equivalent of `cryptoAssetBucket` would be a Fed-meeting or macro-topic bucket.
**Design decision needed:** What's the economics equivalent of "same asset"? For Fed decisions it's "same meeting date." For CPI it's "same report month." The proposer needs a `econTopicBucket(title)` function similar to `cryptoAssetBucket`. Decide the bucketing logic before building.
**Test:** `node scripts/review/pmci-propose-links-economics.mjs --dry-run --verbose`

### [G] Daily status digest Edge Function
**What:** Supabase Edge Function (or extend pmci-job-runner) that runs daily and posts a status summary somewhere you'll see it — could be a Supabase table, a webhook, or just logged. Same data as [F] but automated.
**Depends on:** [F] for the query logic.
**Touches:** New edge function or new job in `supabase/functions/pmci-job-runner/index.ts`, new cron migration.
**Overlaps with:** [C] and [E] confirm cron infrastructure works. If those fail, fix cron before adding more jobs.

---

## Group 3 — Do when the moment is right (no urgency)

### [H] Context hygiene — archive old docs
**What:** Move historical plan docs, sprint evidence, audit snapshots into `docs/archive/`. Trim `system-state.md` to current block only. Trim `roadmap.md` completed phases to one-liners.
**Depends on:** Nothing. Do when context bloat causes visible friction in a session.
**Touches:** `docs/` file moves, `docs/system-state.md`, `docs/roadmap.md`
**Overlaps with:** None. Pure cleanup.

### [I] Golden fixtures
**What:** Pick 2–5 cross-venue events (one per category) with good market depth. Freeze the provider-native JSON + normalized rows as fixture files. Use as regression tests when decomposition rules change.
**Depends on:** [A] and [D] landing so you have ladder families to fixture against.
**Touches:** New directory `test/fixtures/golden/`, new test script.
**Overlaps with:** [J] coverage benchmark produces raw API snapshots that could seed these.

### [J] Weekly coverage benchmark cron
**What:** Schedule `npm run pmci:benchmark:coverage` as a weekly cron. Archive output to `output/benchmark/` with dated filenames.
**Depends on:** [C]/[E] confirming cron works. Also needs `ODDPOOL_API_KEY` set on Fly or as a Supabase secret.
**Touches:** New cron migration, possibly new admin-jobs route for benchmark.
**Overlaps with:** [I] can use benchmark output as fixture source material.

---

## Group 4 — Design decisions (conversation, not code)

### [K] Divergence scoring for ladder families
**What:** Current `signals/top-divergences` computes a binary YES/NO mid spread. Ladder families with 28 strikes need a distribution-level comparison. Decide the scoring model before Phase F begins.
**Depends on:** [A] and [D] landing so you have real ladder families to look at.
**This is a design conversation, not a build task.** When you're ready, ask: "I have ladder families with 28 Kalshi strikes and 15 Polymarket strikes at different boundaries. How should I score divergence across the whole distribution?"

### [L] Canonical event lifecycle
**What:** When a game market settles or a Fed meeting resolves, what happens to the canonical event and its families? Auto-archive? Delete? Mark resolved? Currently open carry-forward from E1.6.
**Depends on:** Nothing, but low urgency until stale resolved events accumulate enough to cause noise.
**This is a design conversation, not a build task.** When you notice resolved events polluting proposals or observer cycles, that's the trigger.
