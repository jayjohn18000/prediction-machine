# Plan: Add `volume_24h` to `provider_markets` for Opportunity Ranking

**Phase:** E2 follow-on (crypto/economics expansion)  
**Estimated effort:** 1 Cursor session  
**Status:** Ready to execute

---

## Context

The crypto proposer (`scripts/review/pmci-propose-links-crypto.mjs`) now produces smart event-grouped proposals instead of a full cross-join. The next unlock is being able to **rank those proposals by trading volume** so the review queue surfaces the highest-opportunity pairs first.

`volume_24h` already flows from Kalshi/Polymarket APIs into `provider_market_snapshots` (it's in the snapshot INSERT). It is **not** stored on `provider_markets` itself, which means every query that wants to rank by volume must do an expensive lateral join or subquery on snapshots.

The fix: add `volume_24h` to `provider_markets`, keep it updated on every ingest upsert, and wire it into the proposer's output and ranking. Sports ingest is the only universe that doesn't capture volume yet — fix that too.

---

## Goal

After this session:
1. `provider_markets.volume_24h` exists as a column (numeric).
2. Every ingest run — crypto, economics, sports, politics — writes it via the upsert.
3. The SQL upsert in `lib/pmci-ingestion.mjs` includes `volume_24h` in both the INSERT and ON CONFLICT UPDATE.
4. The crypto proposer (`scripts/review/pmci-propose-links-crypto.mjs`) pulls `volume_24h` per market and includes it in `features` and uses it to sort proposals (highest combined volume first).
5. `npm run verify:schema` passes.
6. `npm run pmci:smoke` passes.
7. Dry-run of the proposer shows `volume_24h_a` / `volume_24h_b` in the output features.

---

## Files to change

| File | What changes |
|------|-------------|
| `supabase/migrations/<next_timestamp>_pmci_volume24h_column.sql` | Add `volume_24h numeric(20,4)` to `pmci.provider_markets`; update upsert to write it |
| `lib/pmci-ingestion.mjs` | Add `volume_24h` to `SQL_UPSERT_MARKET` INSERT columns + ON CONFLICT UPDATE SET |
| `lib/ingestion/sports-universe.mjs` | Parse `volume_24h` from Kalshi market response and Polymarket response; pass `volume24h` to `ingestProviderMarket` |
| `scripts/review/pmci-propose-links-crypto.mjs` | Pull `volume_24h` when fetching markets; add `volume_24h_a`/`volume_24h_b` to proposal `features`; sort proposals by `(volume_24h_a + volume_24h_b) DESC NULLS LAST` |

Economics and politics universes already pass `volume24h` to `ingestProviderMarket` — they just need the upsert to accept it.

---

## Step-by-step

### Step 1 — Migration

Create `supabase/migrations/20260416000002_pmci_volume24h_column.sql`:

```sql
-- Add volume_24h to provider_markets for direct queryability without snapshot joins
ALTER TABLE pmci.provider_markets
  ADD COLUMN IF NOT EXISTS volume_24h numeric(20,4);

-- Index for ranking queries
CREATE INDEX IF NOT EXISTS idx_provider_markets_volume_24h
  ON pmci.provider_markets (volume_24h DESC NULLS LAST)
  WHERE volume_24h IS NOT NULL;

COMMENT ON COLUMN pmci.provider_markets.volume_24h IS
  'Rolling 24h trading volume from provider API, updated on every ingest upsert.';
```

Apply with: `npm run verify:schema` after applying (or `supabase db push` locally).

---

### Step 2 — Update `lib/pmci-ingestion.mjs`

In `SQL_UPSERT_MARKET`:

**INSERT column list** — add `volume_24h` as the last column before the closing paren:
```sql
  volume_24h
```

**VALUES list** — add `$19` (it becomes the 19th parameter after away_team at $18).

**ON CONFLICT UPDATE SET** — add:
```sql
    volume_24h = COALESCE(EXCLUDED.volume_24h, provider_markets.volume_24h),
```
(Use COALESCE so a null from a provider that doesn't expose volume doesn't clobber a previously-stored value.)

In the `ingestProviderMarket` function signature / destructuring:
- Already accepts `volume24h` — just wire it into the upsert params array at position index 19.

Verify the param array order matches the new column order.

---

### Step 3 — Fix sports universe

In `lib/ingestion/sports-universe.mjs`, find the `ingestProviderMarket` call for **Kalshi** markets and add:
```js
volume24h: parseNum(m?.volume_24h ?? m?.volume_24h_fp) ?? null,
```

Find the `ingestProviderMarket` call for **Polymarket** markets and add:
```js
volume24h: parseNum(m?.volume24hr ?? m?.volume_24hr ?? m?.volume_24h) ?? null,
```

(Polymarket Gamma API uses `volume24hr` on market objects; check raw field names in existing `universe.mjs` lines 414 and 573 for the exact field names — they've already been solved there.)

---

### Step 4 — Update crypto proposer

In `scripts/review/pmci-propose-links-crypto.mjs`:

1. **Fetch `volume_24h`** — when the script fetches Kalshi/Polymarket market rows from `provider_markets`, add `volume_24h` to the SELECT.

2. **Add to features** — in the proposal object's `features` block, include:
   ```js
   volume_24h_a: kalshiMarket.volume_24h ?? null,
   volume_24h_b: polyMarket.volume_24h ?? null,
   volume_24h_combined: ((kalshiMarket.volume_24h ?? 0) + (polyMarket.volume_24h ?? 0)) || null,
   ```

3. **Sort proposals** — before printing/inserting, sort the proposals array:
   ```js
   proposals.sort((a, b) => {
     const va = (a.features?.volume_24h_combined ?? 0);
     const vb = (b.features?.volume_24h_combined ?? 0);
     return vb - va; // highest volume first
   });
   ```

---

### Step 5 — Verify

```bash
# Schema check
npm run verify:schema

# Smoke test
npm run pmci:smoke

# Dry-run proposer — look for volume_24h_a/b in features output
node scripts/review/pmci-propose-links-crypto.mjs --dry-run --verbose --limit 5
```

Expected: proposals show `volume_24h_a`, `volume_24h_b`, `volume_24h_combined` in features. Proposals sorted by combined volume (highest first, NULLs last).

---

## Migration timestamp

Next migration slot: `20260416000002` (one after the auto-review cron migration `20260416000001`).

---

## Notes

- Do NOT touch `provider_market_snapshots` — `volume_24h` already exists there and is correct.
- The `COALESCE` in the upsert ON CONFLICT clause is intentional: some providers (or some market types) don't expose volume. Don't nuke a good value with NULL on the next cycle.
- The crypto proposer currently fetches market rows from `provider_markets` with a WHERE clause — just add `volume_24h` to that SELECT, no schema join needed after this migration.
- After this lands: run `npm run pmci:propose:crypto` (non-dry-run) to generate real proposals ranked by volume.
