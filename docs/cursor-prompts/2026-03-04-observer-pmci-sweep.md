# Cursor Prompt: Expand Observer — PMCI Sweep for Unsnapshotted Markets
> Generated: 2026-03-04
> Agents: @Codebase @Terminal

---

# Plan: Expand Observer to Cover All pmci.provider_markets

## Context

The observer currently only snapshots markets in `event_pairs.json` (paired Kalshi+Polymarket spread pairs). The universe ingest (`pmci:ingest:politics:universe`) has discovered and stored 2,814 markets in `pmci.provider_markets`, but 691 of them have zero snapshots — they were ingested without a price (or with `priceYes = null`) and the spread observer never touches them.

Goal: add a "PMCI sweep" to the observer that, every cycle, queries `pmci.provider_markets` for open/null-status markets lacking a recent snapshot and fetches prices for them using the existing provider adapters.

---

## Ref format analysis

- **Kalshi markets**: `provider_market_ref` = full ticker e.g. `KXTXSEN-26-CORNYN`. Event ticker = strip last dash-segment → `KXTXSEN-26`. Existing `fetchKalshiPriceMap(eventTicker)` returns `Map<ticker → prices>` — just look up the full ticker.
- **Polymarket markets**: `provider_market_ref` = `{slug}#{outcomeName}`. The `outcomeName` is either:
  - A candidate name like `Gavin Newsom` (binary Yes/No market with `groupItemTitle`)
  - A numeric market ID like `562828` (multi-outcome market where `outcomes[]` contained the token ID)
  - An outcome label like `Yes` or `No`

---

## Approach: additive PMCI sweep after main spread cycle

Does not touch spread observer logic. Runs after each event-groups loop every cycle.

---

## Files to touch

| File | Change |
|------|--------|
| `lib/providers/polymarket.mjs` | Export `fetchPolymarketEventData(slug)` — same sticky-base logic, returns raw event JSON (or null). No changes to existing `fetchPolymarketPriceMap`. |
| `lib/ingestion/pmci-sweep.mjs` | **New.** `runPmciSweep({ pmciClient, pmciIds, observedAt })` — queries uncovered markets, groups by (provider, event_ref/slug), fetches + appends snapshots. |
| `lib/ingestion/observer-cycle.mjs` | Call `runPmciSweep` at end of `runObserverCycle` (skip if pmci not available). |

---

## Diff outline

### `lib/providers/polymarket.mjs`

Add after the existing `fetchPolymarketEvent` definition (no signature change):

```js
/**
 * Fetch raw event data by slug using the same sticky-base logic as fetchPolymarketPriceMap.
 * Returns the parsed event JSON (with .markets array) or null on failure.
 */
export async function fetchPolymarketEventData(slug) {
  if (polymarketBase) {
    const d = await fetchPolymarketEvent(polymarketBase, slug);
    if (d?.markets?.length) return d;
    polymarketBase = null;
  }
  for (const base of POLYMARKET_BASES) {
    const d = await fetchPolymarketEvent(base, slug);
    if (d?.markets?.length) {
      polymarketBase = base;
      return d;
    }
  }
  return null;
}
```

### `lib/ingestion/pmci-sweep.mjs` (new file)

```js
/**
 * PMCI sweep: snapshot all open pmci.provider_markets that lack a recent observation.
 * Runs after the main spread-observer cycle to cover markets not in event_pairs.json.
 * Does NOT write to prediction_market_spreads.
 */
import { fetchKalshiPriceMap } from '../providers/kalshi.mjs';
import { fetchPolymarketEventData } from '../providers/polymarket.mjs';
import { appendProviderMarketSnapshot } from '../pmci-ingestion.mjs';

// SQL: markets with status open (or null) and no snapshot in last 10 minutes
const SQL_STALE_MARKETS = `
  SELECT pm.id, pm.provider_market_ref, pm.event_ref, p.code AS provider_code
  FROM pmci.provider_markets pm
  JOIN pmci.providers p ON p.id = pm.provider_id
  WHERE (pm.status IS NULL OR pm.status = 'open')
    AND NOT EXISTS (
      SELECT 1 FROM pmci.provider_market_snapshots s
      WHERE s.provider_market_id = pm.id
        AND s.observed_at > now() - interval '10 minutes'
    )
  ORDER BY pm.id
  LIMIT $1
`;

const BATCH_LIMIT = Number(process.env.PMCI_SWEEP_BATCH_LIMIT ?? '600');

function extractKalshiEventTicker(ref) {
  // KXTXSEN-26-CORNYN → KXTXSEN-26 (strip last dash-segment)
  const idx = ref.lastIndexOf('-');
  return idx > 0 ? ref.slice(0, idx) : ref;
}

function extractSlug(ref) {
  const idx = ref.indexOf('#');
  return idx > 0 ? ref.slice(0, idx) : ref;
}

function extractOutcomeName(ref) {
  const idx = ref.indexOf('#');
  return idx >= 0 ? ref.slice(idx + 1) : '';
}

function extractMarketPrice(market) {
  let prices = market?.outcomePrices;
  if (typeof prices === 'string') { try { prices = JSON.parse(prices); } catch { prices = null; } }
  const raw = Array.isArray(prices) ? prices[0] : null;
  const yes = raw != null ? (typeof raw === 'number' ? raw : parseFloat(raw)) : null;
  const priceYes = yes != null && !Number.isNaN(yes) && yes >= 0 && yes <= 1 ? yes : null;
  const bestBid = market?.bestBid != null ? parseFloat(market.bestBid) : null;
  const bestAsk = market?.bestAsk != null ? parseFloat(market.bestAsk) : null;
  // fallback: mid
  const mid = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null;
  return {
    priceYes: priceYes ?? (mid != null && mid >= 0 && mid <= 1 ? mid : null),
    bestBidYes: bestBid != null && bestBid >= 0 && bestBid <= 1 ? bestBid : null,
    bestAskYes: bestAsk != null && bestAsk >= 0 && bestAsk <= 1 ? bestAsk : null,
  };
}

function findPolymarketMatch(markets, outcomeName) {
  // 1. numeric/string ID match (for refs like slug#562828)
  const byId = markets.find(m =>
    String(m.id ?? '') === outcomeName || String(m.conditionId ?? '') === outcomeName
  );
  if (byId) return byId;
  // 2. groupItemTitle match (for binary yes/no with candidate name)
  const byTitle = markets.find(m =>
    String(m.groupItemTitle ?? '').trim() === outcomeName
  );
  if (byTitle) return byTitle;
  // 3. question includes match
  return markets.find(m => String(m.question ?? '').includes(outcomeName)) ?? null;
}

export async function runPmciSweep({ pmciClient, pmciIds, observedAt }) {
  if (!pmciClient || !pmciIds) return { snapshotsAppended: 0, marketsCovered: 0, errors: 0 };

  const res = await pmciClient.query(SQL_STALE_MARKETS, [BATCH_LIMIT]);
  const rows = res.rows ?? [];
  if (rows.length === 0) return { snapshotsAppended: 0, marketsCovered: 0, errors: 0 };

  // Group by (provider_code, event_ref or slug)
  const kalshiGroups = new Map(); // eventTicker → [row, ...]
  const polyGroups = new Map();   // slug → [row, ...]

  for (const row of rows) {
    if (row.provider_code === 'kalshi') {
      const et = row.event_ref || extractKalshiEventTicker(row.provider_market_ref);
      if (!kalshiGroups.has(et)) kalshiGroups.set(et, []);
      kalshiGroups.get(et).push(row);
    } else if (row.provider_code === 'polymarket') {
      const slug = row.event_ref || extractSlug(row.provider_market_ref);
      if (!polyGroups.has(slug)) polyGroups.set(slug, []);
      polyGroups.get(slug).push(row);
    }
  }

  let snapshotsAppended = 0;
  let marketsCovered = 0;
  let errors = 0;

  // Kalshi sweep
  for (const [eventTicker, group] of kalshiGroups) {
    try {
      const r = await fetchKalshiPriceMap(eventTicker);
      if (!r.ok || !r.map) continue;
      for (const row of group) {
        const priceData = r.map.get(row.provider_market_ref);
        if (!priceData) continue;
        const priceYes = priceData.yesAsk ?? priceData.yesBid ?? priceData.yes;
        if (priceYes == null || priceYes < 0 || priceYes > 1) continue;
        await appendProviderMarketSnapshot(pmciClient, {
          providerMarketId: row.id,
          observedAt,
          priceYes,
          bestBidYes: priceData.yesBid ?? null,
          bestAskYes: priceData.yesAsk ?? null,
          liquidity: priceData.openInterest ?? null,
          volume24h: priceData.volume24h ?? null,
          raw: priceData,
        });
        snapshotsAppended += 1;
        marketsCovered += 1;
      }
    } catch (err) {
      errors += 1;
      console.warn(`PMCI sweep kalshi error for ${eventTicker}:`, err.message);
    }
  }

  // Polymarket sweep
  for (const [slug, group] of polyGroups) {
    try {
      const eventData = await fetchPolymarketEventData(slug);
      if (!eventData?.markets?.length) continue;
      for (const row of group) {
        const outcomeName = extractOutcomeName(row.provider_market_ref);
        const market = findPolymarketMatch(eventData.markets, outcomeName);
        if (!market) continue;
        const { priceYes, bestBidYes, bestAskYes } = extractMarketPrice(market);
        if (priceYes == null) continue;
        await appendProviderMarketSnapshot(pmciClient, {
          providerMarketId: row.id,
          observedAt,
          priceYes,
          bestBidYes,
          bestAskYes,
          liquidity: market.liquidity != null ? parseFloat(market.liquidity) : null,
          volume24h: market.volume24hr != null ? parseFloat(market.volume24hr) : null,
          raw: market,
        });
        snapshotsAppended += 1;
        marketsCovered += 1;
      }
    } catch (err) {
      errors += 1;
      console.warn(`PMCI sweep polymarket error for ${slug}:`, err.message);
    }
  }

  return { snapshotsAppended, marketsCovered, errors };
}
```

### `lib/ingestion/observer-cycle.mjs`

- Add at top: `import { runPmciSweep } from './pmci-sweep.mjs';`
- At the end of `runObserverCycle`, after `writeHeartbeat`, add:

```js
// PMCI sweep: snapshot markets not covered by spread pairs (runs every cycle)
if (pmciClientRef?.value && pmciIdsRef?.value) {
  const sweepAt = new Date().toISOString();
  try {
    const sweep = await runPmciSweep({ pmciClient: pmciClientRef.value, pmciIds: pmciIdsRef.value, observedAt: sweepAt });
    if (sweep.snapshotsAppended > 0) {
      console.log(`PMCI sweep: snapshots_appended=${sweep.snapshotsAppended} markets_covered=${sweep.marketsCovered}`);
    }
    if (sweep.errors > 0) {
      console.warn(`PMCI sweep: errors=${sweep.errors}`);
    }
  } catch (err) {
    console.warn('PMCI sweep error:', err.message);
  }
}
```

---

## Config/schema impact

- No migrations needed — all writes use existing `pmci.provider_market_snapshots` and `appendProviderMarketSnapshot`.
- New env var: `PMCI_SWEEP_BATCH_LIMIT` (default `600`, max stale markets per sweep per cycle).

---

## Risks

- **Rate limiting**: ~50 HTTP calls per cycle (one per event group). Running every 60s is well within API limits.
- **Sweep does not update `prediction_market_spreads`** — by design. These are PMCI-only markets.
- **Unmatched markets**: silently skipped if outcomeName doesn't match API response. Coverage improves as Polymarket fills placeholders.

---

## Verification steps (run after implementation)

```bash
node --test test/routes/*.test.mjs test/ingestion/*.test.mjs   # all 6 must pass
npm run pmci:smoke                                              # baseline counts
npm run start                                                   # run 2+ cycles; look for "PMCI sweep: snapshots_appended=N"
node scripts/db-audit.mjs                                       # markets_without_snapshots should drop from 691
```

---

## Sanity checklist

- [ ] No changes to `prediction_market_spreads` insert path
- [ ] No changes to `event_pairs.json` schema or shape
- [ ] Sweep runs only when `pmciClientRef.value` is non-null (degrades gracefully)
- [ ] `PMCI_SWEEP_BATCH_LIMIT` documented in `.env.example`
- [ ] `appendProviderMarketSnapshot` reused unchanged from `lib/pmci-ingestion.mjs`
