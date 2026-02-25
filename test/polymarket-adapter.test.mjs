import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { mapPolymarketEventToCanonical } = await import('../lib/providers/polymarket-adapter.mjs');

function loadFixture(name) {
  const p = path.join(__dirname, '..', 'fixtures', name);
  const raw = fs.readFileSync(p, 'utf8');
  return JSON.parse(raw);
}

test('mapPolymarketEventToCanonical maps event and markets into canonical schema', () => {
  const { event, markets } = loadFixture('polymarket-event-sample.json');

  const canonical = mapPolymarketEventToCanonical({ event, markets });

  assert.equal(
    canonical.id,
    'democratic-presidential-nominee-2028',
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

  assert.equal(yesOutcome.label, 'Yes');
  assert.equal(noOutcome.label, 'No');

  assert.deepEqual(
    Object.keys(newsomMarket.providers).sort(),
    ['polymarket'].sort(),
  );
  assert.equal(newsomMarket.providers.polymarket.marketId, 'cond-newsom');
  assert.equal(yesOutcome.providers.polymarket.tokenId, 'token-newsom-yes');
  assert.equal(noOutcome.providers.polymarket.tokenId, 'token-newsom-no');
});

