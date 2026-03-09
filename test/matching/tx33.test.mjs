import test from 'node:test';
import assert from 'node:assert/strict';
import { extractTopicSignature } from '../../lib/matching/proposal-engine.mjs';

test('TX-33 topic signature is deterministic across ref/title forms', () => {
  const fromRef = extractTopicSignature({ provider_market_ref: 'HOUSE-TX-33-2026' });
  const fromTitleA = extractTopicSignature({ title: 'TX-33 House election 2026' });
  const fromTitleB = extractTopicSignature({ title: 'Texas 33rd district house race 2026' });

  assert.equal(fromRef, 'house_tx33_2026');
  assert.equal(fromTitleA, 'house_tx33_2026');
  assert.equal(fromTitleB, 'house_tx33_2026');
});
