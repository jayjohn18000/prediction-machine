import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { mapKalshiEventToCanonical } = await import('../lib/providers/kalshi-adapter.mjs');

function loadFixture(name) {
  const p = path.join(__dirname, '..', 'fixtures', name);
  const raw = fs.readFileSync(p, 'utf8');
  return JSON.parse(raw);
}

test('mapKalshiEventToCanonical maps event and markets into canonical schema', () => {
  const { event, series, markets } = loadFixture('kalshi-event-sample.json');

  const canonical = mapKalshiEventToCanonical({ event, series, markets });

  assert.equal(
    canonical.id,
    'us-presidential-nomination-democratic-2028-2028-democratic-presidential-nominee',
  );
  assert.equal(canonical.title, '2028 Democratic Presidential Nominee');
  assert.equal(canonical.category, 'politics');
  assert.equal(canonical.subcategory, 'election');
  assert.equal(canonical.region, 'us');

  assert.equal(canonical.markets.length, 2);

  const newsomMarket = canonical.markets.find((m) => m.id.endsWith('/gavin-newsom'));
  assert.ok(newsomMarket, 'should contain market for Gavin Newsom');
  assert.equal(newsomMarket.type, 'binary');
  assert.equal(newsomMarket.outcomes.length, 2);

  const yesOutcome = newsomMarket.outcomes.find((o) => o.role === 'yes');
  const noOutcome = newsomMarket.outcomes.find((o) => o.role === 'no');

  assert.ok(yesOutcome, 'YES outcome should exist');
  assert.ok(noOutcome, 'NO outcome should exist');

  assert.equal(yesOutcome.label, 'Gavin Newsom');
  assert.equal(noOutcome.label, 'Someone else');

  assert.deepEqual(
    Object.keys(newsomMarket.providers).sort(),
    ['kalshi'].sort(),
  );
  assert.equal(newsomMarket.providers.kalshi.ticker, 'KXPRESNOMD-28-GN');
});

