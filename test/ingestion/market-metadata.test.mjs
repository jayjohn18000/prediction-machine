import test from 'node:test';
import assert from 'node:assert/strict';
import { inferPoliticalMetadata } from '../../lib/ingestion/services/market-metadata.mjs';

test('inferPoliticalMetadata: president nominee slug', () => {
  const m = inferPoliticalMetadata('democratic-presidential-nominee-2028', 'Who will win?');
  assert.equal(m.office, 'president');
  assert.equal(m.normalizedEventKey, 'president_us_2028');
  assert.equal(m.jurisdiction, 'us_federal');
  assert.equal(m.subjectType, 'candidate');
});

test('inferPoliticalMetadata: senate state/year extraction', () => {
  const m = inferPoliticalMetadata('senate-ohio-2026', 'Ohio Senate Election 2026');
  assert.equal(m.office, 'senate');
  assert.equal(m.normalizedEventKey, 'senate_ohio_2026');
  assert.equal(m.jurisdiction, 'us_state_oh');
  assert.equal(m.year, 2026);
});

test('inferPoliticalMetadata: governor title with state name', () => {
  const m = inferPoliticalMetadata('random', 'North Carolina Governor race 2024');
  assert.equal(m.office, 'governor');
  assert.equal(m.normalizedEventKey, 'gov_north_carolina_2024');
  assert.equal(m.jurisdiction, 'us_state_nc');
});
