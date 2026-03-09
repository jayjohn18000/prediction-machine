import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTopicKey } from '../../lib/matching/proposal-engine.mjs';

test('normalizeTopicKey canonicalizes gov aliases', () => {
  assert.equal(normalizeTopicKey('gov_oh_2026'), 'governor_oh_2026');
  assert.equal(normalizeTopicKey('gov_ohio_2026'), 'governor_oh_2026');
  assert.equal(normalizeTopicKey('governor_tx_2026'), 'governor_tx_2026');
});
