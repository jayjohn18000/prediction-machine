import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePolymarketSportLabel,
  inferSportFromPolymarketTags,
  SPORT_CODES,
  isSportsCategory,
  getAllSportCodes,
} from '../lib/ingestion/services/sport-inference.mjs';
import {
  inferSportFromKalshiTicker,
  isKalshiSportsTicker,
  REGRESSION_TICKERS,
  KALSHI_SPORTS_SERIES_TICKERS,
} from '../lib/ingestion/sports-universe.mjs';

test('normalizePolymarketSportLabel: handles null/undefined', () => {
  assert.equal(normalizePolymarketSportLabel(null), '');
  assert.equal(normalizePolymarketSportLabel(undefined), '');
  assert.equal(normalizePolymarketSportLabel(''), '');
});

test('normalizePolymarketSportLabel: converts to lowercase slug', () => {
  assert.equal(normalizePolymarketSportLabel('NFL'), 'nfl');
  assert.equal(normalizePolymarketSportLabel('NFL Football'), 'nfl-football');
  assert.equal(normalizePolymarketSportLabel('  NBA  '), 'nba');
});

test('normalizePolymarketSportLabel: replaces special chars', () => {
  assert.equal(normalizePolymarketSportLabel('NFL_Football'), 'nfl-football');
  assert.equal(normalizePolymarketSportLabel('NBA - Basketball'), 'nba-basketball');
  assert.equal(normalizePolymarketSportLabel('Premier League!!!'), 'premier-league');
});

test('normalizePolymarketSportLabel: collapses multiple hyphens', () => {
  assert.equal(normalizePolymarketSportLabel('NFL---Football'), 'nfl-football');
  assert.equal(normalizePolymarketSportLabel('---NBA---'), 'nba');
});

test('inferSportFromPolymarketTags: descriptive tag - NFL', () => {
  const result = inferSportFromPolymarketTags(['nfl'], 'Some title');
  assert.equal(result.sportCode, SPORT_CODES.NFL);
  assert.equal(result.source, 'tag');
  assert.equal(result.matchedTag, 'nfl');
});

test('inferSportFromPolymarketTags: descriptive tag - Basketball', () => {
  const result = inferSportFromPolymarketTags(['basketball'], 'NBA Finals');
  assert.equal(result.sportCode, SPORT_CODES.NBA);
  assert.equal(result.source, 'tag');
});

test('inferSportFromPolymarketTags: descriptive tag - Soccer variants', () => {
  assert.equal(inferSportFromPolymarketTags(['soccer']).sportCode, SPORT_CODES.SOCCER);
  assert.equal(inferSportFromPolymarketTags(['premier-league']).sportCode, SPORT_CODES.SOCCER);
  assert.equal(inferSportFromPolymarketTags(['champions-league']).sportCode, SPORT_CODES.SOCCER);
  assert.equal(inferSportFromPolymarketTags(['world-cup']).sportCode, SPORT_CODES.SOCCER);
});

test('inferSportFromPolymarketTags: object tags with slug', () => {
  const result = inferSportFromPolymarketTags([{ slug: 'nba', label: 'NBA Basketball' }]);
  assert.equal(result.sportCode, SPORT_CODES.NBA);
  assert.equal(result.source, 'tag');
});

test('inferSportFromPolymarketTags: object tags with label fallback', () => {
  const result = inferSportFromPolymarketTags([{ label: 'MLB Baseball' }]);
  assert.equal(result.sportCode, SPORT_CODES.MLB);
  assert.equal(result.source, 'tag');
});

test('inferSportFromPolymarketTags: numeric tags fallback to title', () => {
  const result = inferSportFromPolymarketTags(
    [{ id: 12345 }, { id: '67890' }],
    'Who will win the NFL Super Bowl?'
  );
  assert.equal(result.sportCode, SPORT_CODES.NFL);
  assert.equal(result.source, 'title');
});

test('inferSportFromPolymarketTags: empty tags fallback to title', () => {
  const result = inferSportFromPolymarketTags([], 'NBA Championship 2026');
  assert.equal(result.sportCode, SPORT_CODES.NBA);
  assert.equal(result.source, 'title');
});

test('inferSportFromPolymarketTags: no tags and no title match', () => {
  const result = inferSportFromPolymarketTags([], 'Random market title');
  assert.equal(result.sportCode, SPORT_CODES.UNKNOWN);
  assert.equal(result.source, 'none');
});

test('inferSportFromPolymarketTags: title patterns - UFC', () => {
  const result = inferSportFromPolymarketTags([], 'UFC 300: Who will win?');
  assert.equal(result.sportCode, SPORT_CODES.UFC);
});

test('inferSportFromPolymarketTags: title patterns - Boxing', () => {
  const result = inferSportFromPolymarketTags([], 'WBA Championship Boxing Match');
  assert.equal(result.sportCode, SPORT_CODES.BOXING);
});

test('inferSportFromPolymarketTags: title patterns - Tennis Grand Slams', () => {
  assert.equal(
    inferSportFromPolymarketTags([], 'Wimbledon 2026 Winner').sportCode,
    SPORT_CODES.TENNIS
  );
  assert.equal(
    inferSportFromPolymarketTags([], 'US Open Tennis Finals').sportCode,
    SPORT_CODES.TENNIS
  );
  assert.equal(
    inferSportFromPolymarketTags([], 'French Open Roland Garros').sportCode,
    SPORT_CODES.TENNIS
  );
});

test('inferSportFromPolymarketTags: title patterns - F1', () => {
  assert.equal(
    inferSportFromPolymarketTags([], 'F1 Monaco Grand Prix').sportCode,
    SPORT_CODES.F1
  );
  assert.equal(
    inferSportFromPolymarketTags([], 'Formula 1 Championship').sportCode,
    SPORT_CODES.F1
  );
});

test('inferSportFromPolymarketTags: title patterns - College sports', () => {
  assert.equal(
    inferSportFromPolymarketTags([], 'March Madness 2026').sportCode,
    SPORT_CODES.COLLEGE_BASKETBALL
  );
  assert.equal(
    inferSportFromPolymarketTags([], 'College Football Playoff').sportCode,
    SPORT_CODES.COLLEGE_FOOTBALL
  );
});

test('inferSportFromPolymarketTags: title patterns - Esports', () => {
  assert.equal(
    inferSportFromPolymarketTags([], 'LoL World Championship').sportCode,
    SPORT_CODES.ESPORTS
  );
});

test('inferSportFromPolymarketTags: mixed valid and invalid tags', () => {
  const result = inferSportFromPolymarketTags(
    [{ id: 123 }, 'invalid-sport', 'nhl'],
    'Hockey game'
  );
  assert.equal(result.sportCode, SPORT_CODES.NHL);
  assert.equal(result.source, 'tag');
});

test('inferSportFromKalshiTicker: known prefixes', () => {
  assert.equal(inferSportFromKalshiTicker('KXNFL-SUPERBOWL-2026'), SPORT_CODES.NFL);
  assert.equal(inferSportFromKalshiTicker('KXNBA-FINALS-2026'), SPORT_CODES.NBA);
  assert.equal(inferSportFromKalshiTicker('KXMLB-WS-2026'), SPORT_CODES.MLB);
  assert.equal(inferSportFromKalshiTicker('KXNHL-STANLEY-2026'), SPORT_CODES.NHL);
  assert.equal(inferSportFromKalshiTicker('KXUFC-300'), SPORT_CODES.UFC);
});

test('inferSportFromKalshiTicker: case insensitive', () => {
  assert.equal(inferSportFromKalshiTicker('kxnfl-game'), SPORT_CODES.NFL);
  assert.equal(inferSportFromKalshiTicker('KxNbA-finals'), SPORT_CODES.NBA);
});

test('inferSportFromKalshiTicker: unknown ticker', () => {
  assert.equal(inferSportFromKalshiTicker('KXPOLITICS-2026'), SPORT_CODES.UNKNOWN);
  assert.equal(inferSportFromKalshiTicker('RANDOM-TICKER'), SPORT_CODES.UNKNOWN);
});

test('inferSportFromKalshiTicker: null/undefined', () => {
  assert.equal(inferSportFromKalshiTicker(null), SPORT_CODES.UNKNOWN);
  assert.equal(inferSportFromKalshiTicker(undefined), SPORT_CODES.UNKNOWN);
  assert.equal(inferSportFromKalshiTicker(''), SPORT_CODES.UNKNOWN);
});

test('isKalshiSportsTicker: returns boolean', () => {
  assert.equal(isKalshiSportsTicker('KXNFL-GAME'), true);
  assert.equal(isKalshiSportsTicker('KXPOLITICS'), false);
});

test('isSportsCategory: valid sports categories', () => {
  assert.equal(isSportsCategory('sports'), true);
  assert.equal(isSportsCategory('Sports'), true);
  assert.equal(isSportsCategory('sport'), true);
  assert.equal(isSportsCategory('sports-betting'), true);
});

test('isSportsCategory: non-sports categories', () => {
  assert.equal(isSportsCategory('politics'), false);
  assert.equal(isSportsCategory('crypto'), false);
  assert.equal(isSportsCategory(null), false);
  assert.equal(isSportsCategory(undefined), false);
});

test('getAllSportCodes: returns array of all codes', () => {
  const codes = getAllSportCodes();
  assert.ok(Array.isArray(codes));
  assert.ok(codes.includes('nfl'));
  assert.ok(codes.includes('nba'));
  assert.ok(codes.includes('unknown_sport'));
});

test('REGRESSION_TICKERS: all resolve to expected sport codes', () => {
  for (const { ticker, expectedSport } of REGRESSION_TICKERS) {
    const result = inferSportFromKalshiTicker(ticker);
    assert.equal(
      result,
      expectedSport,
      `Ticker ${ticker} should resolve to ${expectedSport}, got ${result}`
    );
  }
});

test('KALSHI_SPORTS_SERIES_TICKERS: all are recognized as sports', () => {
  for (const ticker of KALSHI_SPORTS_SERIES_TICKERS) {
    assert.ok(
      isKalshiSportsTicker(ticker),
      `Ticker ${ticker} should be recognized as sports ticker`
    );
  }
});

test('SPORT_CODES: is frozen object', () => {
  assert.ok(Object.isFrozen(SPORT_CODES));
});

test('SPORT_CODES: contains expected values', () => {
  assert.equal(SPORT_CODES.NFL, 'nfl');
  assert.equal(SPORT_CODES.NBA, 'nba');
  assert.equal(SPORT_CODES.UNKNOWN, 'unknown_sport');
});
