/**
 * Sport inference service for Kalshi markets.
 * Provides pattern-based sport and league detection from market tickers.
 * Used for Phase E1.5 sport ingestion.
 */

/**
 * @typedef {Object} SportInferenceResult
 * @property {string} sport - Detected sport (e.g., 'baseball', 'basketball', 'football')
 * @property {string} league - Detected league (e.g., 'MLB', 'NBA', 'NFL')
 * @property {string} confidence - 'high', 'medium', or 'low'
 */

/**
 * Pattern rules for Kalshi sport ticker inference.
 * Order matters: specific patterns first, broad catch-alls last.
 *
 * @type {Array<{pattern: RegExp, sport: string, league: string, confidence: string}>}
 */
const KALSHI_SPORT_PATTERNS = [
  // ============================================================
  // BASEBALL - Specific Patterns
  // ============================================================
  { pattern: /^KXMLB/i, sport: 'baseball', league: 'MLB', confidence: 'high' },
  { pattern: /^MLBW-/i, sport: 'baseball', league: 'MLB', confidence: 'high' },
  { pattern: /^MLBWS/i, sport: 'baseball', league: 'MLB', confidence: 'high' },
  { pattern: /^MLB[A-Z]{2,3}-/i, sport: 'baseball', league: 'MLB', confidence: 'high' },
  { pattern: /-MLB-/i, sport: 'baseball', league: 'MLB', confidence: 'high' },
  { pattern: /WORLDSERIES/i, sport: 'baseball', league: 'MLB', confidence: 'high' },

  // ============================================================
  // BASKETBALL - NBA Specific Patterns
  // ============================================================
  { pattern: /^KXNBA/i, sport: 'basketball', league: 'NBA', confidence: 'high' },
  { pattern: /^NBAW-/i, sport: 'basketball', league: 'NBA', confidence: 'high' },
  { pattern: /^NBAF-/i, sport: 'basketball', league: 'NBA', confidence: 'high' },
  { pattern: /^NBA[A-Z]{2,3}-/i, sport: 'basketball', league: 'NBA', confidence: 'high' },
  { pattern: /-NBA-/i, sport: 'basketball', league: 'NBA', confidence: 'high' },
  { pattern: /NBAFINALS/i, sport: 'basketball', league: 'NBA', confidence: 'high' },
  { pattern: /NBAPLAYOFFS/i, sport: 'basketball', league: 'NBA', confidence: 'high' },

  // ============================================================
  // BASKETBALL - WNBA Patterns
  // ============================================================
  { pattern: /^KXWNBA/i, sport: 'basketball', league: 'WNBA', confidence: 'high' },
  { pattern: /^WNBA/i, sport: 'basketball', league: 'WNBA', confidence: 'high' },
  { pattern: /-WNBA-/i, sport: 'basketball', league: 'WNBA', confidence: 'high' },

  // ============================================================
  // FOOTBALL - NFL Specific Patterns
  // ============================================================
  { pattern: /^KXNFL/i, sport: 'football', league: 'NFL', confidence: 'high' },
  { pattern: /^NFLW-/i, sport: 'football', league: 'NFL', confidence: 'high' },
  { pattern: /^NFL[A-Z]{2,3}-/i, sport: 'football', league: 'NFL', confidence: 'high' },
  { pattern: /-NFL-/i, sport: 'football', league: 'NFL', confidence: 'high' },
  { pattern: /SUPERBOWL/i, sport: 'football', league: 'NFL', confidence: 'high' },
  { pattern: /NFLPLAYOFFS/i, sport: 'football', league: 'NFL', confidence: 'high' },

  // ============================================================
  // HOCKEY - NHL Specific Patterns
  // ============================================================
  { pattern: /^KXNHL/i, sport: 'hockey', league: 'NHL', confidence: 'high' },
  { pattern: /^NHLW-/i, sport: 'hockey', league: 'NHL', confidence: 'high' },
  { pattern: /^NHL[A-Z]{2,3}-/i, sport: 'hockey', league: 'NHL', confidence: 'high' },
  { pattern: /-NHL-/i, sport: 'hockey', league: 'NHL', confidence: 'high' },
  { pattern: /STANLEYCUP/i, sport: 'hockey', league: 'NHL', confidence: 'high' },
  { pattern: /NHLPLAYOFFS/i, sport: 'hockey', league: 'NHL', confidence: 'high' },

  // ============================================================
  // COLLEGE FOOTBALL - NCAAF Patterns
  // ============================================================
  { pattern: /^KXNCAAF/i, sport: 'football', league: 'NCAAF', confidence: 'high' },
  { pattern: /^NCAAF/i, sport: 'football', league: 'NCAAF', confidence: 'high' },
  { pattern: /-NCAAF-/i, sport: 'football', league: 'NCAAF', confidence: 'high' },
  { pattern: /COLLEGEFOOTBALL/i, sport: 'football', league: 'NCAAF', confidence: 'high' },
  { pattern: /CFP-/i, sport: 'football', league: 'NCAAF', confidence: 'high' },
  { pattern: /CFBPLAYOFF/i, sport: 'football', league: 'NCAAF', confidence: 'high' },
  { pattern: /HEISMANTROPHY/i, sport: 'football', league: 'NCAAF', confidence: 'high' },

  // ============================================================
  // COLLEGE BASKETBALL - NCAAB / NCAAM / NCAAW Patterns
  // ============================================================
  { pattern: /^KXNCAAB/i, sport: 'basketball', league: 'NCAAB', confidence: 'high' },
  { pattern: /^KXNCAAM/i, sport: 'basketball', league: 'NCAAM', confidence: 'high' },
  { pattern: /^KXNCAAW/i, sport: 'basketball', league: 'NCAAW', confidence: 'high' },
  { pattern: /^NCAAB/i, sport: 'basketball', league: 'NCAAB', confidence: 'high' },
  { pattern: /^NCAAM/i, sport: 'basketball', league: 'NCAAM', confidence: 'high' },
  { pattern: /^NCAAW/i, sport: 'basketball', league: 'NCAAW', confidence: 'high' },
  { pattern: /-NCAAB-/i, sport: 'basketball', league: 'NCAAB', confidence: 'high' },
  { pattern: /-NCAAM-/i, sport: 'basketball', league: 'NCAAM', confidence: 'high' },
  { pattern: /-NCAAW-/i, sport: 'basketball', league: 'NCAAW', confidence: 'high' },
  { pattern: /MARCHMADNESS/i, sport: 'basketball', league: 'NCAAB', confidence: 'high' },
  { pattern: /FINALFOUR/i, sport: 'basketball', league: 'NCAAB', confidence: 'high' },
  { pattern: /COLLEGEBASKETBALL/i, sport: 'basketball', league: 'NCAAB', confidence: 'medium' },

  // ============================================================
  // SOCCER - MLS Patterns
  // ============================================================
  { pattern: /^KXMLS/i, sport: 'soccer', league: 'MLS', confidence: 'high' },
  { pattern: /^MLS[A-Z]{0,3}-/i, sport: 'soccer', league: 'MLS', confidence: 'high' },
  { pattern: /-MLS-/i, sport: 'soccer', league: 'MLS', confidence: 'high' },
  { pattern: /MLSCUP/i, sport: 'soccer', league: 'MLS', confidence: 'high' },

  // ============================================================
  // SOCCER - Liga MX Patterns
  // ============================================================
  { pattern: /^KXLIGAMX/i, sport: 'soccer', league: 'LIGAMX', confidence: 'high' },
  { pattern: /^LIGAMX/i, sport: 'soccer', league: 'LIGAMX', confidence: 'high' },
  { pattern: /-LIGAMX-/i, sport: 'soccer', league: 'LIGAMX', confidence: 'high' },
  { pattern: /LIGAMXAP/i, sport: 'soccer', league: 'LIGAMX', confidence: 'high' },
  { pattern: /LIGAMXCL/i, sport: 'soccer', league: 'LIGAMX', confidence: 'high' },
  { pattern: /LIGABBVA/i, sport: 'soccer', league: 'LIGAMX', confidence: 'high' },

  // ============================================================
  // SOCCER - EPL / Premier League Patterns
  // ============================================================
  { pattern: /^KXEPL/i, sport: 'soccer', league: 'EPL', confidence: 'high' },
  { pattern: /^EPL[A-Z]{0,3}-/i, sport: 'soccer', league: 'EPL', confidence: 'high' },
  { pattern: /-EPL-/i, sport: 'soccer', league: 'EPL', confidence: 'high' },
  { pattern: /PREMIERLEAGUE/i, sport: 'soccer', league: 'EPL', confidence: 'high' },

  // ============================================================
  // SOCCER - UEFA Champions League Patterns
  // ============================================================
  { pattern: /^KXUCL/i, sport: 'soccer', league: 'UCL', confidence: 'high' },
  { pattern: /^UCL[A-Z]{0,3}-/i, sport: 'soccer', league: 'UCL', confidence: 'high' },
  { pattern: /-UCL-/i, sport: 'soccer', league: 'UCL', confidence: 'high' },
  { pattern: /CHAMPIONSLEAGUE/i, sport: 'soccer', league: 'UCL', confidence: 'high' },

  // ============================================================
  // SOCCER - La Liga Patterns
  // ============================================================
  { pattern: /^KXLALIGA/i, sport: 'soccer', league: 'LALIGA', confidence: 'high' },
  { pattern: /^LALIGA/i, sport: 'soccer', league: 'LALIGA', confidence: 'high' },
  { pattern: /-LALIGA-/i, sport: 'soccer', league: 'LALIGA', confidence: 'high' },

  // ============================================================
  // SOCCER - Serie A Patterns
  // ============================================================
  { pattern: /^KXSERIEA/i, sport: 'soccer', league: 'SERIEA', confidence: 'high' },
  { pattern: /^SERIEA/i, sport: 'soccer', league: 'SERIEA', confidence: 'high' },
  { pattern: /-SERIEA-/i, sport: 'soccer', league: 'SERIEA', confidence: 'high' },

  // ============================================================
  // SOCCER - Bundesliga Patterns
  // ============================================================
  { pattern: /^KXBUNDESLIGA/i, sport: 'soccer', league: 'BUNDESLIGA', confidence: 'high' },
  { pattern: /^BUNDESLIGA/i, sport: 'soccer', league: 'BUNDESLIGA', confidence: 'high' },
  { pattern: /-BUNDESLIGA-/i, sport: 'soccer', league: 'BUNDESLIGA', confidence: 'high' },

  // ============================================================
  // SOCCER - Ligue 1 Patterns
  // ============================================================
  { pattern: /^KXLIGUE1/i, sport: 'soccer', league: 'LIGUE1', confidence: 'high' },
  { pattern: /^LIGUE1/i, sport: 'soccer', league: 'LIGUE1', confidence: 'high' },
  { pattern: /-LIGUE1-/i, sport: 'soccer', league: 'LIGUE1', confidence: 'high' },

  // ============================================================
  // SOCCER - World Cup / International Patterns
  // ============================================================
  { pattern: /^KXWORLDCUP/i, sport: 'soccer', league: 'FIFA', confidence: 'high' },
  { pattern: /FIFAWORLDCUP/i, sport: 'soccer', league: 'FIFA', confidence: 'high' },
  { pattern: /WORLDCUP/i, sport: 'soccer', league: 'FIFA', confidence: 'medium' },
  { pattern: /EUROS?20\d{2}/i, sport: 'soccer', league: 'UEFA', confidence: 'high' },
  { pattern: /EUROPEANCHAMPIONSHIP/i, sport: 'soccer', league: 'UEFA', confidence: 'high' },
  { pattern: /COPAAMERICA/i, sport: 'soccer', league: 'CONMEBOL', confidence: 'high' },

  // ============================================================
  // SOCCER - NWSL Patterns (Women's Soccer)
  // ============================================================
  { pattern: /^KXNWSL/i, sport: 'soccer', league: 'NWSL', confidence: 'high' },
  { pattern: /^NWSL/i, sport: 'soccer', league: 'NWSL', confidence: 'high' },
  { pattern: /-NWSL-/i, sport: 'soccer', league: 'NWSL', confidence: 'high' },

  // ============================================================
  // GOLF - PGA / LPGA Patterns
  // ============================================================
  { pattern: /^KXPGA/i, sport: 'golf', league: 'PGA', confidence: 'high' },
  { pattern: /^PGA[A-Z]{0,3}-/i, sport: 'golf', league: 'PGA', confidence: 'high' },
  { pattern: /-PGA-/i, sport: 'golf', league: 'PGA', confidence: 'high' },
  { pattern: /PGATOUR/i, sport: 'golf', league: 'PGA', confidence: 'high' },
  { pattern: /^KXLPGA/i, sport: 'golf', league: 'LPGA', confidence: 'high' },
  { pattern: /^LPGA/i, sport: 'golf', league: 'LPGA', confidence: 'high' },
  { pattern: /MASTERS20\d{2}/i, sport: 'golf', league: 'PGA', confidence: 'high' },
  { pattern: /THEMASTERSN/i, sport: 'golf', league: 'PGA', confidence: 'high' },
  { pattern: /USOPEN.*GOLF/i, sport: 'golf', league: 'PGA', confidence: 'high' },
  { pattern: /BRITISHOPEN/i, sport: 'golf', league: 'PGA', confidence: 'high' },
  { pattern: /THEOPEN/i, sport: 'golf', league: 'PGA', confidence: 'medium' },
  { pattern: /PCHAMPIONSHIP/i, sport: 'golf', league: 'PGA', confidence: 'high' },
  { pattern: /RYDERCUP/i, sport: 'golf', league: 'PGA', confidence: 'high' },

  // ============================================================
  // TENNIS - ATP / WTA Patterns
  // ============================================================
  { pattern: /^KXATP/i, sport: 'tennis', league: 'ATP', confidence: 'high' },
  { pattern: /^ATP[A-Z]{0,3}-/i, sport: 'tennis', league: 'ATP', confidence: 'high' },
  { pattern: /-ATP-/i, sport: 'tennis', league: 'ATP', confidence: 'high' },
  { pattern: /^KXWTA/i, sport: 'tennis', league: 'WTA', confidence: 'high' },
  { pattern: /^WTA[A-Z]{0,3}-/i, sport: 'tennis', league: 'WTA', confidence: 'high' },
  { pattern: /-WTA-/i, sport: 'tennis', league: 'WTA', confidence: 'high' },
  { pattern: /USOPEN.*TENNIS/i, sport: 'tennis', league: 'ATP', confidence: 'high' },
  { pattern: /WIMBLEDON/i, sport: 'tennis', league: 'ATP', confidence: 'high' },
  { pattern: /FRENCHOPEN/i, sport: 'tennis', league: 'ATP', confidence: 'high' },
  { pattern: /AUSTRALIANOPEN/i, sport: 'tennis', league: 'ATP', confidence: 'high' },

  // ============================================================
  // MOTORSPORTS - F1 / NASCAR / INDYCAR Patterns
  // ============================================================
  { pattern: /^KXF1/i, sport: 'motorsport', league: 'F1', confidence: 'high' },
  { pattern: /^F1[A-Z]{0,3}-/i, sport: 'motorsport', league: 'F1', confidence: 'high' },
  { pattern: /-F1-/i, sport: 'motorsport', league: 'F1', confidence: 'high' },
  { pattern: /FORMULA1/i, sport: 'motorsport', league: 'F1', confidence: 'high' },
  { pattern: /FORMULAONE/i, sport: 'motorsport', league: 'F1', confidence: 'high' },
  { pattern: /^KXNASCAR/i, sport: 'motorsport', league: 'NASCAR', confidence: 'high' },
  { pattern: /^NASCAR/i, sport: 'motorsport', league: 'NASCAR', confidence: 'high' },
  { pattern: /-NASCAR-/i, sport: 'motorsport', league: 'NASCAR', confidence: 'high' },
  { pattern: /^KXINDYCAR/i, sport: 'motorsport', league: 'INDYCAR', confidence: 'high' },
  { pattern: /^INDYCAR/i, sport: 'motorsport', league: 'INDYCAR', confidence: 'high' },
  { pattern: /INDY500/i, sport: 'motorsport', league: 'INDYCAR', confidence: 'high' },
  { pattern: /DAYTONA500/i, sport: 'motorsport', league: 'NASCAR', confidence: 'high' },

  // ============================================================
  // UFC / MMA Patterns
  // ============================================================
  { pattern: /^KXUFC/i, sport: 'mma', league: 'UFC', confidence: 'high' },
  { pattern: /^UFC\d{3}/i, sport: 'mma', league: 'UFC', confidence: 'high' },
  { pattern: /^UFC[A-Z]{0,3}-/i, sport: 'mma', league: 'UFC', confidence: 'high' },
  { pattern: /-UFC-/i, sport: 'mma', league: 'UFC', confidence: 'high' },
  { pattern: /UFCFIGHT/i, sport: 'mma', league: 'UFC', confidence: 'high' },

  // ============================================================
  // BOXING Patterns
  // ============================================================
  { pattern: /^KXBOXING/i, sport: 'boxing', league: 'BOXING', confidence: 'high' },
  { pattern: /^BOXING/i, sport: 'boxing', league: 'BOXING', confidence: 'high' },
  { pattern: /-BOXING-/i, sport: 'boxing', league: 'BOXING', confidence: 'high' },

  // ============================================================
  // ESPORTS Patterns
  // ============================================================
  { pattern: /^KXESPORTS/i, sport: 'esports', league: 'ESPORTS', confidence: 'high' },
  { pattern: /^KXLOL/i, sport: 'esports', league: 'LOL', confidence: 'high' },
  { pattern: /^KXCS2/i, sport: 'esports', league: 'CS2', confidence: 'high' },
  { pattern: /^KXCSGO/i, sport: 'esports', league: 'CSGO', confidence: 'high' },
  { pattern: /^KXVALORANT/i, sport: 'esports', league: 'VALORANT', confidence: 'high' },
  { pattern: /^KXDOTA/i, sport: 'esports', league: 'DOTA2', confidence: 'high' },
  { pattern: /LEAGUEOFLEGENDS/i, sport: 'esports', league: 'LOL', confidence: 'high' },

  // ============================================================
  // OLYMPICS Patterns
  // ============================================================
  { pattern: /^KXOLYMPICS/i, sport: 'olympics', league: 'OLYMPICS', confidence: 'high' },
  { pattern: /OLYMPICS20\d{2}/i, sport: 'olympics', league: 'OLYMPICS', confidence: 'high' },
  { pattern: /SUMMEROLYMPICS/i, sport: 'olympics', league: 'OLYMPICS', confidence: 'high' },
  { pattern: /WINTEROLYMPICS/i, sport: 'olympics', league: 'OLYMPICS', confidence: 'high' },

  // ============================================================
  // CRICKET Patterns
  // ============================================================
  { pattern: /^KXCRICKET/i, sport: 'cricket', league: 'CRICKET', confidence: 'high' },
  { pattern: /^KXIPL/i, sport: 'cricket', league: 'IPL', confidence: 'high' },
  { pattern: /^IPL[A-Z]{0,3}-/i, sport: 'cricket', league: 'IPL', confidence: 'high' },
  { pattern: /-IPL-/i, sport: 'cricket', league: 'IPL', confidence: 'high' },
  { pattern: /CRICKETWORLDCUP/i, sport: 'cricket', league: 'ICC', confidence: 'high' },
  { pattern: /T20WORLDCUP/i, sport: 'cricket', league: 'ICC', confidence: 'high' },

  // ============================================================
  // HORSE RACING Patterns
  // ============================================================
  { pattern: /^KXHORSERACING/i, sport: 'horse_racing', league: 'HORSE_RACING', confidence: 'high' },
  { pattern: /KENTUCKYDERBY/i, sport: 'horse_racing', league: 'HORSE_RACING', confidence: 'high' },
  { pattern: /PREAKNESS/i, sport: 'horse_racing', league: 'HORSE_RACING', confidence: 'high' },
  { pattern: /BELMONTSTAKES/i, sport: 'horse_racing', league: 'HORSE_RACING', confidence: 'high' },
  { pattern: /TRIPLECROWN/i, sport: 'horse_racing', league: 'HORSE_RACING', confidence: 'high' },

  // ============================================================
  // RUGBY Patterns
  // ============================================================
  { pattern: /^KXRUGBY/i, sport: 'rugby', league: 'RUGBY', confidence: 'high' },
  { pattern: /RUGBYWORLDCUP/i, sport: 'rugby', league: 'RUGBY_WC', confidence: 'high' },
  { pattern: /SIXNATIONS/i, sport: 'rugby', league: 'SIX_NATIONS', confidence: 'high' },

  // ============================================================
  // BROAD CATCH-ALL PATTERNS (must be last)
  // These provide fallback detection for any KX ticker containing sport league names
  // ============================================================
  { pattern: /^KX.*MLB/i, sport: 'baseball', league: 'MLB', confidence: 'medium' },
  { pattern: /^KX.*NBA/i, sport: 'basketball', league: 'NBA', confidence: 'medium' },
  { pattern: /^KX.*NFL/i, sport: 'football', league: 'NFL', confidence: 'medium' },
  { pattern: /^KX.*NHL/i, sport: 'hockey', league: 'NHL', confidence: 'medium' },
  { pattern: /^KX.*NCAAF/i, sport: 'football', league: 'NCAAF', confidence: 'medium' },
  { pattern: /^KX.*NCAAB/i, sport: 'basketball', league: 'NCAAB', confidence: 'medium' },
  { pattern: /^KX.*NCAAM/i, sport: 'basketball', league: 'NCAAM', confidence: 'medium' },
  { pattern: /^KX.*NCAAW/i, sport: 'basketball', league: 'NCAAW', confidence: 'medium' },
];

/**
 * Infer sport and league from a Kalshi ticker.
 *
 * @param {string} ticker - Kalshi market ticker
 * @returns {SportInferenceResult | null} - Sport inference result or null if no match
 */
export function inferSportFromKalshiTicker(ticker) {
  if (!ticker || typeof ticker !== 'string') {
    return null;
  }

  const normalizedTicker = ticker.trim().toUpperCase();

  for (const rule of KALSHI_SPORT_PATTERNS) {
    if (rule.pattern.test(normalizedTicker)) {
      return {
        sport: rule.sport,
        league: rule.league,
        confidence: rule.confidence,
      };
    }
  }

  return null;
}

/**
 * Check if a ticker appears to be a sports-related market.
 *
 * @param {string} ticker - Kalshi market ticker
 * @returns {boolean}
 */
export function isKalshiSportTicker(ticker) {
  return inferSportFromKalshiTicker(ticker) !== null;
}

/**
 * Get all supported leagues for a given sport.
 *
 * @param {string} sport - Sport name (e.g., 'basketball', 'football')
 * @returns {string[]} - Array of league names
 */
export function getLeaguesForSport(sport) {
  const normalizedSport = (sport || '').toLowerCase();
  const leagues = new Set();

  for (const rule of KALSHI_SPORT_PATTERNS) {
    if (rule.sport === normalizedSport) {
      leagues.add(rule.league);
    }
  }

  return Array.from(leagues);
}

/**
 * Get all supported sports.
 *
 * @returns {string[]} - Array of sport names
 */
export function getSupportedSports() {
  const sports = new Set();

  for (const rule of KALSHI_SPORT_PATTERNS) {
    sports.add(rule.sport);
  }

  return Array.from(sports);
}

/**
 * Infer sport metadata from a Kalshi series/event for canonical mapping.
 *
 * @param {object} series - Kalshi series object
 * @param {object} event - Kalshi event object
 * @returns {{sport: string, league: string, confidence: string} | null}
 */
export function inferSportMetadata(series, event) {
  const seriesTicker = series?.ticker || '';
  const eventTicker = event?.event_ticker || '';

  const fromEvent = inferSportFromKalshiTicker(eventTicker);
  if (fromEvent) {
    return fromEvent;
  }

  const fromSeries = inferSportFromKalshiTicker(seriesTicker);
  if (fromSeries) {
    return fromSeries;
  }

  const tags = Array.isArray(series?.tags) ? series.tags : [];
  for (const tag of tags) {
    const tagStr = String(tag).toLowerCase();
    if (tagStr.includes('sports') || tagStr.includes('sport')) {
      const category = String(series?.category || '').toLowerCase();
      if (category.includes('sport')) {
        return {
          sport: 'unknown',
          league: 'UNKNOWN',
          confidence: 'low',
        };
      }
    }
  }

  return null;
}
