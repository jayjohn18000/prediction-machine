/**
 * Unit tests for lib/matching/scoring.mjs (extracted Stage 5 decomposition).
 *
 * Covers: tokenize, jaccard, slugSimilarity, keywordOverlapScore, computeEntityOverlap,
 *         normalizeOutcomeName, parseVectorColumn, cosineSimilarity, scorePair, maxWeightBipartite.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROXY_POLITICS_KEYWORDS,
  tokenize,
  jaccard,
  slugSimilarity,
  keywordOverlapScore,
  computeEntityOverlap,
  normalizeOutcomeName,
  parseVectorColumn,
  cosineSimilarity,
  scorePair,
  maxWeightBipartite,
} from '../../lib/matching/scoring.mjs';

// ---------------------------------------------------------------------------
// tokenize
// ---------------------------------------------------------------------------

test('tokenize: splits and lowercases', () => {
  assert.deepEqual(tokenize('Hello World'), ['hello', 'world']);
});

test('tokenize: filters single-char tokens', () => {
  const result = tokenize('a be the fox');
  assert.deepEqual(result, ['be', 'the', 'fox']);
});

test('tokenize: handles empty/null', () => {
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize(null), []);
  assert.deepEqual(tokenize(undefined), []);
});

test('tokenize: strips non-alpha except hyphens, trims leading/trailing hyphens', () => {
  const result = tokenize('will-trump win? 2026!');
  assert.ok(result.includes('will-trump') || (result.includes('will') && result.includes('trump')));
  assert.ok(result.includes('win'));
  assert.ok(result.includes('2026'));
});

// ---------------------------------------------------------------------------
// jaccard
// ---------------------------------------------------------------------------

test('jaccard: identical sets → 1', () => {
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
});

test('jaccard: disjoint sets → 0', () => {
  assert.equal(jaccard(new Set(['a']), new Set(['b'])), 0);
});

test('jaccard: partial overlap', () => {
  const result = jaccard(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd']));
  // inter=2, union=4 → 0.5
  assert.equal(result, 0.5);
});

test('jaccard: empty sets → 0', () => {
  assert.equal(jaccard(new Set(), new Set()), 0);
});

// ---------------------------------------------------------------------------
// slugSimilarity
// ---------------------------------------------------------------------------

test('slugSimilarity: same tokens → 1', () => {
  assert.equal(slugSimilarity(['trump', '2028'], ['trump', '2028']), 1);
});

test('slugSimilarity: empty arrays → 0', () => {
  assert.equal(slugSimilarity([], []), 0);
});

// ---------------------------------------------------------------------------
// keywordOverlapScore
// ---------------------------------------------------------------------------

test('keywordOverlapScore: shared politics keyword → > 0', () => {
  const score = keywordOverlapScore(['senate', 'race'], ['senate', 'election']);
  assert.ok(score > 0, `expected > 0, got ${score}`);
});

test('keywordOverlapScore: no keywords → 0', () => {
  assert.equal(keywordOverlapScore(['foo', 'bar'], ['baz', 'qux']), 0);
});

test('keywordOverlapScore: empty inputs → 0', () => {
  assert.equal(keywordOverlapScore([], []), 0);
});

test('PROXY_POLITICS_KEYWORDS contains expected tokens', () => {
  assert.ok(PROXY_POLITICS_KEYWORDS.has('senate'));
  assert.ok(PROXY_POLITICS_KEYWORDS.has('governor'));
  assert.ok(PROXY_POLITICS_KEYWORDS.has('nominee'));
  assert.ok(!PROXY_POLITICS_KEYWORDS.has('notatoken'));
});

// ---------------------------------------------------------------------------
// computeEntityOverlap
// ---------------------------------------------------------------------------

test('computeEntityOverlap: full overlap → 1', () => {
  assert.equal(computeEntityOverlap(['trump'], ['trump']), 1);
});

test('computeEntityOverlap: no overlap → 0', () => {
  assert.equal(computeEntityOverlap(['trump'], ['harris']), 0);
});

test('computeEntityOverlap: empty arrays → null', () => {
  assert.equal(computeEntityOverlap([], []), null);
});

test('computeEntityOverlap: partial overlap → 0.5', () => {
  assert.equal(computeEntityOverlap(['donald', 'trump'], ['trump', 'harris']), 0.5);
});

// ---------------------------------------------------------------------------
// normalizeOutcomeName
// ---------------------------------------------------------------------------

test('normalizeOutcomeName: trims and lowercases', () => {
  assert.equal(normalizeOutcomeName('  TRUMP  '), 'trump');
});

test('normalizeOutcomeName: handles null/undefined', () => {
  assert.equal(normalizeOutcomeName(null), '');
  assert.equal(normalizeOutcomeName(undefined), '');
});

// ---------------------------------------------------------------------------
// parseVectorColumn
// ---------------------------------------------------------------------------

test('parseVectorColumn: parses bracket string', () => {
  const result = parseVectorColumn('[1.0, 2.0, 3.0]');
  assert.deepEqual(result, [1, 2, 3]);
});

test('parseVectorColumn: passes through array', () => {
  const result = parseVectorColumn([1, 2, 3]);
  assert.deepEqual(result, [1, 2, 3]);
});

test('parseVectorColumn: returns null for null/empty', () => {
  assert.equal(parseVectorColumn(null), null);
  assert.equal(parseVectorColumn(''), null);
  assert.equal(parseVectorColumn('[]'), null);
});

// ---------------------------------------------------------------------------
// cosineSimilarity
// ---------------------------------------------------------------------------

test('cosineSimilarity: identical unit vectors → 1', () => {
  const v = [1, 0, 0];
  const result = cosineSimilarity(v, v);
  assert.ok(Math.abs(result - 1) < 1e-9, `expected ~1, got ${result}`);
});

test('cosineSimilarity: orthogonal vectors → 0', () => {
  const result = cosineSimilarity([1, 0], [0, 1]);
  assert.ok(Math.abs(result) < 1e-9, `expected ~0, got ${result}`);
});

test('cosineSimilarity: null inputs → null', () => {
  assert.equal(cosineSimilarity(null, [1, 0]), null);
  assert.equal(cosineSimilarity([1, 0], null), null);
});

test('cosineSimilarity: zero vectors → null', () => {
  assert.equal(cosineSimilarity([0, 0], [1, 1]), null);
});

// ---------------------------------------------------------------------------
// scorePair (mirrors golden fixture algorithm)
// ---------------------------------------------------------------------------

test('scorePair: perfect match → high equiv confidence', () => {
  const result = scorePair({}, {}, {
    titleSim: 1,
    slugSim: 1,
    entityMatch: true,
    sharedTopics: true,
    keywordOverlapScore: 1,
    entityStrength: 1,
    topicMatchBonus: 0.1,
    timeWindowBonus: 0.05,
    embeddingSim: 1,
  });
  assert.equal(result.equivalent_confidence, 1);
  assert.ok(result.proxy_confidence >= 0.97, `expected proxy_confidence >= 0.97, got ${result.proxy_confidence}`);
});

test('scorePair: no match → low confidence', () => {
  const result = scorePair({}, {}, {
    titleSim: 0,
    slugSim: 0,
    entityMatch: false,
    sharedTopics: false,
    keywordOverlapScore: 0,
    entityStrength: 0,
    topicMatchBonus: 0,
    timeWindowBonus: 0,
    embeddingSim: 0,
  });
  assert.ok(result.equivalent_confidence < 0.5, `expected < 0.5, got ${result.equivalent_confidence}`);
  assert.ok(result.proxy_confidence < 0.5, `expected < 0.5, got ${result.proxy_confidence}`);
});

test('scorePair: proxy_confidence capped at 0.97', () => {
  const result = scorePair({}, {}, {
    titleSim: 1,
    slugSim: 1,
    entityMatch: true,
    sharedTopics: true,
    keywordOverlapScore: 1,
    entityStrength: 1,
    topicMatchBonus: 0.5,
    timeWindowBonus: 0.5,
    embeddingSim: 1,
  });
  assert.ok(result.proxy_confidence <= 0.97, `proxy_confidence must not exceed 0.97, got ${result.proxy_confidence}`);
});

// ---------------------------------------------------------------------------
// maxWeightBipartite
// ---------------------------------------------------------------------------

test('maxWeightBipartite: empty inputs → []', () => {
  assert.deepEqual(maxWeightBipartite([], [], []), []);
  assert.deepEqual(maxWeightBipartite(['a'], [], []), []);
  assert.deepEqual(maxWeightBipartite([], ['b'], []), []);
});

test('maxWeightBipartite: single edge chosen', () => {
  const edges = [{ leftId: 'a', rightId: 'b', weight: 0.9 }];
  const result = maxWeightBipartite(['a'], ['b'], edges);
  assert.equal(result.length, 1);
  assert.equal(result[0].leftId, 'a');
  assert.equal(result[0].rightId, 'b');
});

test('maxWeightBipartite: picks higher weight edge when competing', () => {
  // a→b (0.9) vs a→c (0.5) — should pick a→b
  const edges = [
    { leftId: 'a', rightId: 'b', weight: 0.9 },
    { leftId: 'a', rightId: 'c', weight: 0.5 },
  ];
  const result = maxWeightBipartite(['a'], ['b', 'c'], edges);
  assert.equal(result.length, 1);
  assert.equal(result[0].rightId, 'b');
});

test('maxWeightBipartite: one-to-one constraint — right node used once', () => {
  // a→c (0.9), b→c (0.8), b→d (0.7) — optimal: a→c (0.9) + b→d (0.7) = 1.6 > a→c (0.9) + b→c collision
  const edges = [
    { leftId: 'a', rightId: 'c', weight: 0.9 },
    { leftId: 'b', rightId: 'c', weight: 0.8 },
    { leftId: 'b', rightId: 'd', weight: 0.7 },
  ];
  const result = maxWeightBipartite(['a', 'b'], ['c', 'd'], edges);
  // a gets c, b gets d
  const rightIds = result.map((e) => e.rightId);
  assert.ok(rightIds.includes('c'), 'c must be assigned');
  assert.ok(rightIds.includes('d'), 'd must be assigned');
  assert.equal(new Set(rightIds).size, rightIds.length, 'no right node used twice');
});
