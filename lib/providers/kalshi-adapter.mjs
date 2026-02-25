import { normalizeSlug, PROVIDER_IDS } from '../events-schema.mjs';

/**
 * Infer a coarse region string from Kalshi series data.
 * Falls back to 'global' if nothing clear is available.
 *
 * @param {object} series
 * @returns {string}
 */
function inferRegionFromSeries(series) {
  const tags = Array.isArray(series?.tags) ? series.tags.map(String) : [];
  const ticker = String(series?.ticker || '').toUpperCase();

  if (tags.some((t) => /US Elections/i.test(t))) return 'us';
  if (tags.some((t) => /Foreign Elections/i.test(t))) return 'global';

  // Heuristic: presence of state/country codes in ticker implies US politics
  if (/US|USA|KX.*PRES/.test(ticker)) return 'us';

  return 'global';
}

/**
 * Infer canonical category/subcategory from Kalshi series/event.
 *
 * @param {object} series
 * @param {object} event
 * @returns {{ category: string, subcategory: string }}
 */
function inferCategory(series, event) {
  const raw = String(series?.category || event?.category || '').toLowerCase();

  if (raw.includes('politic')) {
    return { category: 'politics', subcategory: 'election' };
  }
  if (raw.includes('sport')) {
    return { category: 'sports', subcategory: 'game' };
  }
  if (raw.includes('crypto') || raw.includes('bitcoin') || raw.includes('ethereum')) {
    return { category: 'crypto', subcategory: 'price' };
  }
  if (raw.includes('climate') || raw.includes('weather')) {
    return { category: 'weather', subcategory: 'temperature' };
  }

  return { category: raw || 'unknown', subcategory: 'unknown' };
}

/**
 * Build a stable canonical event ID from Kalshi series + event data.
 *
 * @param {object} params
 * @param {object} params.series
 * @param {object} params.event
 * @returns {string}
 */
function buildCanonicalEventId({ series, event }) {
  const pieces = [];

  const seriesTitle = series?.title ? normalizeSlug(series.title) : null;
  const titleSlug = event?.title ? normalizeSlug(event.title) : null;

  if (seriesTitle) pieces.push(seriesTitle);

  // Extract year if strike_date or event_ticker contains one.
  const strikeDate = event?.strike_date || event?.strikeDate;
  if (typeof strikeDate === 'string' && strikeDate.length >= 4) {
    const year = strikeDate.slice(0, 4);
    if (/^\d{4}$/.test(year)) pieces.push(year);
  }

  if (titleSlug) pieces.push(titleSlug);

  // Fallback: just use event_ticker if we couldn't build a good slug.
  if (pieces.length === 0) {
    return normalizeSlug(String(event?.event_ticker || 'kalshi-event'));
  }

  return pieces.join('-');
}

/**
 * Build a canonical market ID under an event.
 *
 * @param {string} eventId
 * @param {object} market
 * @returns {string}
 */
function buildCanonicalMarketId(eventId, market) {
  const base = eventId;
  const labelSource =
    market?.yes_sub_title ||
    market?.title ||
    market?.ticker ||
    'market';
  const slug = normalizeSlug(String(labelSource));
  return `${base}/${slug || normalizeSlug(String(market?.ticker || 'market'))}`;
}

/**
 * Map a Kalshi event + series + markets bundle into a CanonicalEvent.
 *
 * This is a pure mapping function; network calls should happen in a separate layer.
 *
 * @param {object} params
 * @param {object} params.event
 * @param {object} params.series
 * @param {object[]} params.markets
 * @returns {import('../events-schema.mjs').CanonicalEvent}
 */
export function mapKalshiEventToCanonical({ event, series, markets }) {
  if (!event || !series || !Array.isArray(markets)) {
    throw new Error('mapKalshiEventToCanonical: event, series, and markets are required');
  }

  const { category, subcategory } = inferCategory(series, event);
  const region = inferRegionFromSeries(series);
  const id = buildCanonicalEventId({ series, event });

  /** @type {import('../events-schema.mjs').CanonicalEvent} */
  const canonicalEvent = {
    id,
    title: String(event.title || series.title || event.event_ticker || series.ticker || ''),
    category,
    subcategory,
    region,
    startTime: null,
    endTime: null,
    resolutionTime: null,
    providers: {
      [PROVIDER_IDS.KALSHI]: {
        provider: PROVIDER_IDS.KALSHI,
        eventId: String(event.event_ticker || ''),
        eventTicker: String(event.event_ticker || ''),
        seriesTicker: String(series.ticker || ''),
      },
    },
    markets: [],
  };

  canonicalEvent.markets = markets.map((market) => {
    const marketId = buildCanonicalMarketId(id, market);

    /** @type {import('../events-schema.mjs').CanonicalMarket} */
    const canonicalMarket = {
      id: marketId,
      eventId: id,
      type: 'binary',
      title: String(
        market.title ||
          market.yes_sub_title ||
          `${canonicalEvent.title} – ${market.ticker || ''}`,
      ),
      category,
      subcategory,
      region,
      tradeOpenAt: market.open_time || null,
      tradeCloseAt: market.close_time || null,
      expectedResolveAt: market.expected_expiration_time || null,
      latestResolveAt: market.latest_expiration_time || null,
      outcomes: [],
      providers: {
        [PROVIDER_IDS.KALSHI]: {
          provider: PROVIDER_IDS.KALSHI,
          marketId: String(market.ticker || ''),
          ticker: String(market.ticker || ''),
          eventId: String(event.event_ticker || ''),
        },
      },
    };

    const yesLabel = String(market.yes_sub_title || 'YES');
    const noLabel = String(market.no_sub_title || 'NO');

    canonicalMarket.outcomes = [
      {
        id: `${marketId}-yes`,
        marketId,
        label: yesLabel,
        role: 'yes',
        providers: {
          [PROVIDER_IDS.KALSHI]: {
            provider: PROVIDER_IDS.KALSHI,
            outcomeId: `${market.ticker}-YES`,
            side: 'YES',
          },
        },
      },
      {
        id: `${marketId}-no`,
        marketId,
        label: noLabel,
        role: 'no',
        providers: {
          [PROVIDER_IDS.KALSHI]: {
            provider: PROVIDER_IDS.KALSHI,
            outcomeId: `${market.ticker}-NO`,
            side: 'NO',
          },
        },
      },
    ];

    return canonicalMarket;
  });

  return canonicalEvent;
}

