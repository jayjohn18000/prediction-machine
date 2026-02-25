import test from 'node:test';
import assert from 'node:assert/strict';

const { normalizeSlug } = await import('../lib/events-schema.mjs');

test('normalizeSlug produces stable kebab-case IDs for event titles', () => {
  const cases = [
    {
      input: '2028 US Democratic Presidential Nominee',
      expected: '2028-us-democratic-presidential-nominee',
    },
    {
      input: '  Canada – General Election 2026  ',
      expected: 'canada-general-election-2026',
    },
    {
      input: 'BTC price above 100k by 2030?',
      expected: 'btc-price-above-100k-by-2030',
    },
    {
      input: 'Who will win: Lakers vs. Celtics?',
      expected: 'who-will-win-lakers-vs-celtics',
    },
  ];

  for (const { input, expected } of cases) {
    assert.equal(
      normalizeSlug(input),
      expected,
      `normalizeSlug(${JSON.stringify(input)}) should equal ${JSON.stringify(expected)}`,
    );
  }
});

test('normalizeSlug collapses punctuation and whitespace into single dashes', () => {
  const input = '  Multi   ---   separator___test!!! ';
  const expected = 'multi-separator-test';
  assert.equal(
    normalizeSlug(input),
    expected,
    'normalizeSlug should collapse non-alphanumerics into single dashes',
  );
});

