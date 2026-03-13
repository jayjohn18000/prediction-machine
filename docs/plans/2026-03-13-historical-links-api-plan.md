# Historical Links API — Implementation Plan
**Date:** 2026-03-13
**Branch target:** main
**Estimated time:** ~30 min total
**Scope:** Add `removed_at`/`removed_reason` columns to `market_links` + expose `GET /v1/links` endpoint with full status history.

---

## Context

Post-Politics Phase COMPLETE. Current API exposes only active-link state via `v_market_links_current`. This plan adds the minimal historical surface needed to unlock the **Audit tier ($1k/mo)** without delaying Phase E (sports ingestion).

**What already exists:**
- `market_links.status` soft-delete (`'active'` / `'removed'`)
- `market_links.link_version` for versioning
- `market_links.reasons JSONB` for link evidence
- Full snapshot time series in `provider_market_snapshots`

**What's missing:**
- `removed_at` timestamptz (only `updated_at` today — fragile proxy)
- `removed_reason` text (no taxonomy for why a link was removed)
- Any public API endpoint exposing historical link state

---

## Step 1 — Migration

**File:** `supabase/migrations/20260313000001_pmci_market_links_removal_tracking.sql`

```sql
-- Removal tracking for market_links: timestamp + reason taxonomy.
-- Backfills removed_at from updated_at for existing removed rows (best approximation).

ALTER TABLE pmci.market_links
  ADD COLUMN IF NOT EXISTS removed_at     timestamptz,
  ADD COLUMN IF NOT EXISTS removed_reason text;

-- Backfill: for rows already soft-deleted, updated_at is the closest proxy
UPDATE pmci.market_links
SET removed_at = updated_at
WHERE status = 'removed' AND removed_at IS NULL;

-- Index for status-filtered historical queries
CREATE INDEX IF NOT EXISTS idx_pmci_market_links_status_updated
  ON pmci.market_links(status, updated_at DESC);
```

**Apply:** `npx supabase db push` then `npm run verify:schema`

---

## Step 2 — SQL queries in `src/queries.mjs`

Add two entries to the `SQL` object (before the closing `}`):

```js
  links_history: `
    select
      ml.id,
      ml.family_id,
      ml.provider_market_id,
      ml.status,
      ml.relationship_type,
      ml.link_version,
      ml.confidence,
      ml.reasons,
      ml.removed_at,
      ml.removed_reason,
      ml.created_at,
      ml.updated_at,
      p.code  as provider,
      pm.title as market_title,
      pm.provider_market_ref,
      ce.slug  as event_slug,
      ce.category
    from pmci.market_links ml
    join pmci.providers p          on p.id  = ml.provider_id
    join pmci.provider_markets pm  on pm.id = ml.provider_market_id
    join pmci.market_families mf   on mf.id = ml.family_id
    join pmci.canonical_events ce  on ce.id = mf.canonical_event_id
    where
      ($1::text is null or ml.status  = $1)
      and ($2::text is null or ce.category = $2)
      and ($3::timestamptz is null or ml.created_at >= $3)
    order by ml.updated_at desc
    limit $4
    offset $5;
  `,

  links_history_count: `
    select count(*)::int as total
    from pmci.market_links ml
    join pmci.market_families mf   on mf.id = ml.family_id
    join pmci.canonical_events ce  on ce.id = mf.canonical_event_id
    where
      ($1::text is null or ml.status  = $1)
      and ($2::text is null or ce.category = $2)
      and ($3::timestamptz is null or ml.created_at >= $3);
  `,
```

---

## Step 3 — New route `src/routes/links.mjs`

```js
/**
 * GET /v1/links — historical and current link query across all statuses.
 *
 * Query params:
 *   status   "active" | "removed" | "any"  (default: "active")
 *   topic    category string, e.g. "politics"  (optional)
 *   after    ISO-8601 timestamptz  (optional, filters on created_at)
 *   limit    1–200  (default 50)
 *   offset   integer  (default 0)
 */
export function registerLinksRoutes(app, deps) {
  const { query, SQL, RATE_LIMIT_CONFIG, z } = deps;

  const querySchema = z.object({
    status: z.enum(["active", "removed", "any"]).default("active"),
    topic:  z.string().min(1).optional(),
    after:  z.string().datetime({ offset: true }).optional(),
    limit:  z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  });

  app.get("/v1/links", { rateLimit: RATE_LIMIT_CONFIG }, async (req) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return { error: "invalid_params", detail: parsed.error.flatten() };
    }

    const { status, topic, after, limit, offset } = parsed.data;

    // null → SQL treats as "no filter" via $n::text is null check
    const statusParam = status === "any" ? null : status;
    const topicParam  = topic ?? null;
    const afterParam  = after  ?? null;

    const [{ rows: links }, { rows: countRows }] = await Promise.all([
      query(SQL.links_history,       [statusParam, topicParam, afterParam, limit, offset]),
      query(SQL.links_history_count, [statusParam, topicParam, afterParam]),
    ]);

    return {
      links: links.map((l) => ({
        id:                  Number(l.id),
        family_id:           Number(l.family_id),
        provider_market_id:  Number(l.provider_market_id),
        provider:            l.provider,
        provider_market_ref: l.provider_market_ref,
        market_title:        l.market_title,
        event_slug:          l.event_slug,
        category:            l.category,
        status:              l.status,
        relationship_type:   l.relationship_type,
        link_version:        Number(l.link_version),
        confidence:          Number(l.confidence),
        reasons:             l.reasons ?? {},
        removed_at:          l.removed_at ?? null,
        removed_reason:      l.removed_reason ?? null,
        created_at:          l.created_at,
        updated_at:          l.updated_at,
      })),
      total:   countRows[0]?.total ?? 0,
      limit,
      offset,
      filters: { status, topic: topic ?? null, after: after ?? null },
    };
  });
}
```

---

## Step 4 — Register in `src/server.mjs`

```js
// Add with other route imports
import { registerLinksRoutes } from "./routes/links.mjs";

// Add after registerReviewRoutes(app, deps);
registerLinksRoutes(app, deps);
```

---

## Execution Checklist

- [ ] Write migration file
- [ ] `npx supabase db push`
- [ ] `npm run verify:schema`
- [ ] Add `links_history` + `links_history_count` to `src/queries.mjs`
- [ ] Write `src/routes/links.mjs`
- [ ] Add import + call in `src/server.mjs`
- [ ] Restart API: `npm run api:pmci`
- [ ] Smoke test (see below)

## Smoke Tests

```bash
# Active links (default)
curl -s "http://localhost:8787/v1/links?topic=politics&limit=5" \
  -H "x-pmci-api-key: $PMCI_API_KEY" | jq '{total, count: (.links | length)}'

# All statuses including removed
curl -s "http://localhost:8787/v1/links?status=any&topic=politics&limit=5" \
  -H "x-pmci-api-key: $PMCI_API_KEY" | jq '[.links[] | {id, status, removed_at, removed_reason}]'

# After filter
curl -s "http://localhost:8787/v1/links?status=any&after=2026-03-01T00:00:00Z" \
  -H "x-pmci-api-key: $PMCI_API_KEY" | jq '{total, filters}'
```

---

## Revenue Context

This endpoint unlocks the **Audit tier** pricing:

| Tier | Capabilities | Price |
|---|---|---|
| Active | Current spread + link state | $500/mo |
| **Audit** (this plan) | + `GET /v1/links?status=any` + removal history | **$1,000/mo** |
| Historical | + `/v1/spreads/history` time series | $2,500/mo |
| Enterprise | Full history + raw read replica + SLA | $5,000+/mo |

Historical tier (Endpoints B + C) deferred until after Phase E when sports coverage makes backtesting data dense enough to sell.
