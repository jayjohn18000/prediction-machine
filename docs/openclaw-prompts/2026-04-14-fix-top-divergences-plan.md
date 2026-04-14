# OpenClaw Execution Prompt: Fix signals/top-divergences 503
> Generated: 2026-04-14
> Branch: main

## PMCI Invariants
Do not auto-write to `.env` — print proposed changes only.
Do not skip `npm run verify:schema` after any migration.
New routes in `src/api.mjs` only, never root `api.mjs`.
Do not bulk-inactivate markets without running inactive-guard check first.

## Situation Summary
`GET /v1/signals/top-divergences` returns 503 in two scenarios:
1. The `assertFreshness` preHandler blocks when the observer is not running (lag > MAX_LAG_SECONDS, default 120s). Data is stale but still useful for spread intelligence — the freshness gate should not apply to this endpoint, or should be relaxed to a much longer TTL (e.g. 24h).
2. The endpoint currently **requires** `event_id` (UUID) as a mandatory query param — it is scoped per canonical event, not global. The intended design (per roadmap) is a global ranking of active linked pairs by spread magnitude, with optional `event_id` and `category` filters.

Live DB query confirmed rich data is available: family 38 (RFK Jr.) shows 0.49 divergence, family 3120 shows 0.31, family 51 shows 0.11. The data flows fine — only the API surface is broken.

## Changes Required

### Track A — Fix `src/routes/signals.mjs` (critical path)

**A1:** Remove `assertFreshness` from the `top-divergences` route's `preHandler`. This endpoint serves spread intelligence which is useful even with stale data. Replace with a soft staleness annotation: include `data_lag_seconds` in the response envelope so callers know how fresh the data is.

Current route:
```
app.get("/v1/signals/top-divergences", { preHandler: assertFreshness, rateLimit: RATE_LIMIT_CONFIG }, async (req) => {
  const schema = z.object({
    event_id: z.string().uuid(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  });
  ...
  return getTopDivergences({ query }, parsed.data.event_id, parsed.data.limit);
});
```

New route (make `event_id` optional, add optional `category` filter, remove `assertFreshness`, include lag annotation):
```javascript
app.get("/v1/signals/top-divergences", { rateLimit: RATE_LIMIT_CONFIG }, async (req) => {
  const schema = z.object({
    event_id: z.string().uuid().optional(),
    category: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return { error: parsed.error.flatten() };

  const result = await getTopDivergences({ query }, parsed.data.event_id ?? null, parsed.data.limit, parsed.data.category ?? null);

  // Attach soft staleness annotation — callers can decide if data is fresh enough
  const { rows: lagRows } = await query(`select extract(epoch from (now() - max(observed_at)))::int as lag_seconds from pmci.provider_market_snapshots`);
  const lag = lagRows[0]?.lag_seconds != null ? Number(lagRows[0].lag_seconds) : null;

  return { data_lag_seconds: lag, families: result };
});
```

Hard gate: route must return 200 with `{ data_lag_seconds: <number>, families: [...] }` when called with no params (global mode).

### Track B — Fix `src/services/signal-queries.mjs` (critical path, parallel with A)

**B1:** Modify `getTopDivergences(db, eventId, limit, category)` to support global mode (eventId=null) and optional category filter.

Change the `family_markets` CTE's `WHERE` clause:
- Current: `where f.canonical_event_id = $1` (always required)
- New: make event_id optional — when null, omit the filter entirely; when provided, add it. Add optional category join against `pmci.canonical_events` when `category` is provided.

The simplest approach: build the query with conditional WHERE logic. Use a params array that adjusts based on which filters are provided.

Example pattern:
```javascript
export async function getTopDivergences(db, eventId, limit, category = null) {
  const params = [];
  const conditions = [];

  if (eventId) {
    params.push(eventId);
    conditions.push(`f.canonical_event_id = $${params.length}`);
  }
  if (category) {
    params.push(category);
    conditions.push(`ce.category = $${params.length}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  // add limit as last param
  params.push(limit);
  const limitParam = `$${params.length}`;

  const sql = `
    with latest_snapshots as (
      select distinct on (s.provider_market_id)
        s.provider_market_id, s.observed_at, s.price_yes, s.liquidity, s.best_bid_yes, s.best_ask_yes
      from pmci.provider_market_snapshots s
      order by s.provider_market_id, s.observed_at desc
    ),
    family_markets as (
      select
        f.id as family_id,
        f.canonical_event_id as event_id,
        f.label,
        l.id as link_id,
        p.code as provider,
        l.provider_id,
        l.provider_market_id,
        l.relationship_type,
        l.status,
        l.link_version,
        l.confidence,
        l.correlation_window,
        l.lag_seconds,
        l.correlation_strength,
        l.break_rate,
        l.last_validated_at,
        l.staleness_score,
        l.reasons,
        pm.title as market_title,
        pm.provider_market_ref,
        ls.observed_at,
        ls.price_yes,
        ls.liquidity,
        ls.best_bid_yes,
        ls.best_ask_yes,
        case l.relationship_type
          when 'identical' then 1.0
          when 'equivalent' then 1.0
          when 'proxy' then 0.5
          when 'correlated' then 0.25
          else 0.25
        end as relationship_weight
      from pmci.market_families f
      join pmci.v_market_links_current l on l.family_id = f.id
      join pmci.providers p on p.id = l.provider_id
      join pmci.provider_markets pm on pm.id = l.provider_market_id
      ${category ? 'join pmci.canonical_events ce on ce.id = f.canonical_event_id' : ''}
      left join latest_snapshots ls on ls.provider_market_id = l.provider_market_id
      ${whereClause}
    ),
    ... [rest of CTEs unchanged: scored, ranked, ranked_families, top_families]
    limit ${limitParam}
  `;
  const { rows } = await db.query(sql, params);
  // [existing row grouping logic unchanged]
}
```

Read the full current implementation at:
`/Users/jaylenjohnson/prediction-machine/src/services/signal-queries.mjs`

Preserve all existing CTEs (scored, ranked, ranked_families, top_families) and the row grouping logic exactly. Only change the family_markets CTE's join/WHERE and the function signature.

Hard gate: `getTopDivergences(db, null, 20, null)` must run without error and return an array (may be empty if no active links have prices).

### Track C — Update the failing test

**C1:** Update `test/routes/signals.test.mjs` — the existing test calls with a mandatory `event_id`. Change it to test both modes:
1. Global mode: `GET /v1/signals/top-divergences?limit=5` — expect 200, body has `data_lag_seconds` and `families` array
2. Per-event mode: `GET /v1/signals/top-divergences?event_id=<uuid>&limit=5` — same shape

Also remove the 401-before-assert-equal pattern for the global test since it doesn't need auth context (no `assertFreshness`). Keep the skip-if-no-API-running guard.

Read current test at: `/Users/jaylenjohnson/prediction-machine/test/routes/signals.test.mjs`

Hard gate: `npm test -- --grep "top-divergences"` passes (or skips cleanly if API not running).

## Verification Sequence

Run after all edits:
```bash
cd ~/prediction-machine
npm run verify:schema
npm run pmci:smoke
```

Then do a live API probe (requires the PMCI API to be running):
```bash
curl -s -H "x-pmci-api-key: $PMCI_API_KEY" "http://localhost:8787/v1/signals/top-divergences?limit=5" | jq '{lag: .data_lag_seconds, count: (.families | length), top: .families[0].label}'
```

Hard gate: response is 200 with `families` array, not 503.

## Git Commit
```
fix(signals): make top-divergences global — drop mandatory event_id, relax freshness gate

- event_id now optional; omitting queries all active links globally
- category filter added as optional param
- assertFreshness removed from route; replaced with soft data_lag_seconds annotation in response envelope
- getTopDivergences updated to build conditional WHERE clause
- test updated to cover both global and per-event modes

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

## Reference Files (Plumbo reads these — do not paste contents)
- `/Users/jaylenjohnson/prediction-machine/src/routes/signals.mjs`
- `/Users/jaylenjohnson/prediction-machine/src/services/signal-queries.mjs`
- `/Users/jaylenjohnson/prediction-machine/test/routes/signals.test.mjs`
- `/Users/jaylenjohnson/prediction-machine/docs/system-state.md`
