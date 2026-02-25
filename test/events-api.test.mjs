import test from 'node:test';
import assert from 'node:assert/strict';

import { listMarkets } from '../lib/events-api.mjs';

test('listMarkets returns a shallow copy of markets array', () => {
  const event = {
    id: 'demo-event',
    title: 'Demo',
    category: 'politics',
    subcategory: 'election',
    region: 'us',
    startTime: null,
    endTime: null,
    resolutionTime: null,
    providers: {},
    markets: [
      { id: 'demo-event/market-1' },
      { id: 'demo-event/market-2' },
    ],
  };

  const markets = listMarkets(event);

  assert.equal(markets.length, 2);
  assert.notStrictEqual(markets, event.markets, 'should return a new array instance');
  assert.equal(markets[0].id, 'demo-event/market-1');
});

