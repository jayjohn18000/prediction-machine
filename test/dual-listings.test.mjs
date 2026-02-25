import test from 'node:test';
import assert from 'node:assert/strict';

import { matchCanonicalEvents } from '../lib/dual-listings.mjs';
import { PROVIDER_IDS } from '../lib/events-schema.mjs';

test('matchCanonicalEvents pairs events by normalized title and region', () => {
  const kalshiEvent = {
    id: 'us-presidential-nomination-democratic-2028-2028-democratic-presidential-nominee',
    title: '2028 Democratic Presidential Nominee',
    category: 'politics',
    subcategory: 'election',
    region: 'us',
    startTime: null,
    endTime: null,
    resolutionTime: null,
    providers: {
      [PROVIDER_IDS.KALSHI]: {
        provider: PROVIDER_IDS.KALSHI,
        eventId: 'KXPRESNOMD-28',
        eventTicker: 'KXPRESNOMD-28',
        seriesTicker: 'KXPRESNOMD',
      },
    },
    markets: [],
  };

  const polymarketEvent = {
    id: 'democratic-presidential-nominee-2028',
    title: '2028 Democratic Presidential Nominee',
    category: 'politics',
    subcategory: 'election',
    region: 'us',
    startTime: '2026-01-01T00:00:00Z',
    endTime: '2028-11-07T00:00:00Z',
    resolutionTime: null,
    providers: {
      [PROVIDER_IDS.POLYMARKET]: {
        provider: PROVIDER_IDS.POLYMARKET,
        eventId: 'evt-dem-nom-2028',
        slug: 'democratic-presidential-nominee-2028',
      },
    },
    markets: [],
  };

  const matches = matchCanonicalEvents([kalshiEvent], [polymarketEvent]);

  assert.equal(matches.length, 1);
  assert.equal(matches[0].left.id, kalshiEvent.id);
  assert.equal(matches[0].right.id, polymarketEvent.id);
});

