#!/usr/bin/env node
/**
 * Integration check: GET /v1/signals/top-divergences returns <= limit items;
 * when both legs have prices, items have non-null max_divergence.
 * Usage: ensure API is running (npm run api:pmci), then:
 *   node scripts/check-top-divergences.mjs [baseUrl] [event_id] [limit]
 * Defaults: baseUrl=http://localhost:8787, event_id=DEM UUID, limit=5
 */

const baseUrl = process.argv[2] || 'http://localhost:8787';
const eventId = process.argv[3] || 'c8515a58-c984-46fe-ac65-25e362e68333';
const limit = process.argv[4] || '5';

const url = `${baseUrl}/v1/signals/top-divergences?event_id=${encodeURIComponent(eventId)}&limit=${encodeURIComponent(limit)}`;

async function main() {
  const res = await fetch(url);
  if (!res.ok) {
    console.error('HTTP', res.status, await res.text());
    process.exit(1);
  }
  const data = await res.json();
  if (!Array.isArray(data)) {
    console.error('Expected array, got', typeof data, data?.error ? JSON.stringify(data.error) : '');
    process.exit(1);
  }
  if (data.length > Number(limit)) {
    console.error('Expected ≤', limit, 'items, got', data.length);
    process.exit(1);
  }
  let withPrices = 0;
  let withMaxDiv = 0;
  for (const row of data) {
    const legsWithPrice = (row.legs || []).filter(l => l.price_yes != null);
    if (legsWithPrice.length >= 2) withPrices += 1;
    if (row.max_divergence != null) withMaxDiv += 1;
  }
  console.log('top-divergences: count=%d (limit=%s), families_with_both_prices=%d, with_max_divergence=%d', data.length, limit, withPrices, withMaxDiv);
  if (withPrices > 0 && withMaxDiv === 0) {
    console.error('At least one family has both legs with prices but no max_divergence set.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
