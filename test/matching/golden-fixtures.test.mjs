/**
 * Golden fixture regression harness for lib/matching/proposal-engine.mjs and lib/pmci-matching-adapters.mjs.
 *
 * Captured 2026-03-09 (Step 4.5) before Step 5 decomposition of proposal-engine.mjs.
 * Any failure here indicates a regression in exported matching/scoring behaviour.
 *
 * Fixtures: test/fixtures/matching/*.fixture.json
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

import { extractTopicSignature, normalizeTopicKey } from '../../lib/matching/proposal-engine.mjs';
import { extractMatchingFields } from '../../lib/pmci-matching-adapters.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(__dirname, '../fixtures/matching');

function loadFixture(name) {
  const raw = readFileSync(join(fixtureDir, name), 'utf8');
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// Fixture structure validation helpers
// ---------------------------------------------------------------------------

function assertFixtureStructure(fixture, name) {
  assert.ok(fixture._schema_version >= 1, `${name}: missing or invalid _schema_version`);
  assert.ok(typeof fixture._description === 'string' && fixture._description.length > 0, `${name}: missing _description`);
}

// ---------------------------------------------------------------------------
// 1. extractTopicSignature golden cases
// ---------------------------------------------------------------------------

test('golden: extractTopicSignature fixture structure is valid', () => {
  const fixture = loadFixture('topic-signatures.fixture.json');
  assertFixtureStructure(fixture, 'topic-signatures');
  assert.ok(Array.isArray(fixture.cases) && fixture.cases.length > 0, 'cases array required');
  for (const c of fixture.cases) {
    assert.ok(typeof c.description === 'string', 'each case must have description');
    assert.ok(c.input && typeof c.input === 'object', 'each case must have input object');
    assert.ok('expected' in c, 'each case must have expected field');
    assert.ok(c.expected === null || typeof c.expected === 'string', 'expected must be string or null');
  }
});

test('golden: extractTopicSignature matches all fixture cases', () => {
  const { cases } = loadFixture('topic-signatures.fixture.json');
  for (const { description, input, expected } of cases) {
    const actual = extractTopicSignature(input);
    assert.equal(actual, expected, `extractTopicSignature case: "${description}"`);
  }
});

// ---------------------------------------------------------------------------
// 2. normalizeTopicKey golden cases
// ---------------------------------------------------------------------------

test('golden: normalizeTopicKey fixture structure is valid', () => {
  const fixture = loadFixture('normalize-topic-key.fixture.json');
  assertFixtureStructure(fixture, 'normalize-topic-key');
  assert.ok(Array.isArray(fixture.cases) && fixture.cases.length > 0, 'cases array required');
  for (const c of fixture.cases) {
    assert.ok(typeof c.description === 'string', 'each case must have description');
    assert.ok(typeof c.input === 'string', 'each case input must be a string');
    assert.ok(typeof c.expected === 'string', 'each case expected must be a string');
  }
});

test('golden: normalizeTopicKey matches all fixture cases', () => {
  const { cases } = loadFixture('normalize-topic-key.fixture.json');
  for (const { description, input, expected } of cases) {
    const actual = normalizeTopicKey(input);
    assert.equal(actual, expected, `normalizeTopicKey case: "${description}"`);
  }
});

// ---------------------------------------------------------------------------
// 3. extractMatchingFields golden cases
// ---------------------------------------------------------------------------

test('golden: matching-fields fixture structure is valid', () => {
  const fixture = loadFixture('matching-fields.fixture.json');
  assertFixtureStructure(fixture, 'matching-fields');
  assert.ok(Array.isArray(fixture.cases) && fixture.cases.length > 0, 'cases array required');
  const expectedKeys = ['template', 'jurisdiction', 'cycle', 'party', 'candidateName', 'resolutionYear', 'thresholdValue', 'thresholdAsset'];
  for (const c of fixture.cases) {
    assert.ok(typeof c.description === 'string', 'each case must have description');
    assert.ok(c.input?.market && typeof c.input.venue === 'string', 'each case must have input.market and input.venue');
    for (const key of expectedKeys) {
      assert.ok(key in c.expected, `each expected must have key "${key}" — missing in case "${c.description}"`);
    }
  }
});

test('golden: extractMatchingFields matches all fixture cases', () => {
  const { cases } = loadFixture('matching-fields.fixture.json');
  for (const { description, input, expected } of cases) {
    const actual = extractMatchingFields(input.market, input.venue);
    assert.deepEqual(actual, expected, `extractMatchingFields case: "${description}"`);
  }
});

// ---------------------------------------------------------------------------
// 4. Proposal shape fixture: structure + scoring algorithm consistency
// ---------------------------------------------------------------------------

test('golden: proposal-shape fixture structure is valid', () => {
  const fixture = loadFixture('proposal-shape.fixture.json');
  assertFixtureStructure(fixture, 'proposal-shape');
  assert.ok(Array.isArray(fixture.score_cases) && fixture.score_cases.length > 0, 'score_cases array required');
  assert.ok(fixture.reasons_schema?.required_keys?.length > 0, 'reasons_schema.required_keys required');
  assert.ok(fixture.features_schema?.required_keys?.length > 0, 'features_schema.required_keys required');
  assert.ok(typeof fixture.thresholds === 'object', 'thresholds object required');
  const thresholdKeys = ['equiv_auto_accept_new_pair', 'equiv_pending_min', 'proxy_pending_min'];
  for (const k of thresholdKeys) {
    assert.ok(typeof fixture.thresholds[k] === 'number', `thresholds.${k} must be a number`);
  }
  for (const c of fixture.score_cases) {
    assert.ok(typeof c.description === 'string', 'each score_case must have description');
    assert.ok(c.meta && typeof c.meta === 'object', 'each score_case must have meta');
    assert.ok(c.expected && typeof c.expected === 'object', 'each score_case must have expected');
    assert.ok('equivalent_confidence' in c.expected, 'expected must have equivalent_confidence');
    assert.ok('proxy_confidence' in c.expected, 'expected must have proxy_confidence');
  }
});

/**
 * Inline replication of the internal scorePair() formula.
 * This validates that the fixture score_cases are mathematically consistent with the
 * documented algorithm weights. If Step 5 changes the formula, both the fixture and
 * this reference implementation must be updated together.
 */
function replicateScorePair(meta) {
  const {
    titleSim,
    slugSim,
    entityMatch,
    sharedTopics,
    kwScore = 0,
    entityStrength = entityMatch ? 1 : 0,
    topicMatchBonus = 0,
    timeWindowBonus = 0,
    embeddingSim = null,
  } = meta;
  const entityScore = entityMatch ? 1 : 0;
  const embScore = embeddingSim != null ? embeddingSim : 0;
  const equiv = 0.25 * titleSim + 0.20 * slugSim + 0.25 * entityScore + 0.30 * embScore;
  const equivConf = Math.min(1, equiv + (entityMatch ? 0.15 : 0) + (titleSim > 0.5 ? 0.1 : 0));
  let proxyConf = equivConf * 0.75 + kwScore * 0.15 + entityStrength * 0.1 + topicMatchBonus + timeWindowBonus;
  if (sharedTopics && !entityMatch) proxyConf = Math.min(0.96, proxyConf + 0.1);
  return {
    equivalent_confidence: Math.round(equivConf * 10000) / 10000,
    proxy_confidence: Math.round(Math.min(0.97, proxyConf) * 10000) / 10000,
  };
}

test('golden: score_cases in proposal-shape fixture are mathematically consistent with documented algorithm', () => {
  const { score_cases } = loadFixture('proposal-shape.fixture.json');
  for (const { description, meta, expected } of score_cases) {
    const computed = replicateScorePair(meta);
    assert.equal(
      computed.equivalent_confidence,
      expected.equivalent_confidence,
      `score_case "${description}": equivalent_confidence mismatch`,
    );
    assert.equal(
      computed.proxy_confidence,
      expected.proxy_confidence,
      `score_case "${description}": proxy_confidence mismatch`,
    );
  }
});

test('golden: proposal reasons_schema example contains all required keys', () => {
  const { reasons_schema } = loadFixture('proposal-shape.fixture.json');
  for (const key of reasons_schema.required_keys) {
    assert.ok(key in reasons_schema.example, `reasons_schema.example missing required key "${key}"`);
  }
});

test('golden: proposal features_schema example contains all required keys', () => {
  const { features_schema } = loadFixture('proposal-shape.fixture.json');
  for (const key of features_schema.required_keys) {
    assert.ok(key in features_schema.example, `features_schema.example missing required key "${key}"`);
  }
});

test('golden: confidence thresholds are ordered correctly', () => {
  const { thresholds } = loadFixture('proposal-shape.fixture.json');
  assert.ok(
    thresholds.equiv_pending_min < thresholds.equiv_auto_accept_new_pair,
    'equiv_pending_min must be < equiv_auto_accept_new_pair',
  );
  assert.ok(
    thresholds.proxy_pending_min < thresholds.proxy_max,
    'proxy_pending_min must be < proxy_max',
  );
  assert.ok(
    thresholds.proxy_max <= 0.97,
    'proxy_max must not exceed 0.97',
  );
});
