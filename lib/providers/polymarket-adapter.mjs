import { normalizeSlug, PROVIDER_IDS } from '../events-schema.mjs';

/**
 * Safely parse a JSON-encoded array field from Gamma (e.g. outcomes, outcomePrices, clobTokenIds).
 *
 * @param {string | null | undefined} value
 * @returns {string[]}
 */
function parseJsonArray(value) {
  if (!value || typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Infer canonical category/subcategory from Polymarket event/market.
 *
 * @param {object} event
 * @returns {{ category: string, subcategory: string }}
 */
function inferCategory(event) {
  const raw = String(event?.category || '').toLowerCase();

  if (raw.includes('politic')) {
    return { category: 'politics', subcategory: 'election' };
  }
  if (raw.includes('sport')) {
    return { category: 'sports', subcategory: 'game' };
  }
  if (raw.includes('crypto') || raw.includes('defi')) {
    return { category: 'crypto', subcategory: 'price' };
  }

  return { category: raw || 'unknown', subcategory: 'unknown' };
}

/**
 * Infer a coarse region from event tags and title.
 *
 * @param {object} event
 * @returns {string}
 */
function inferRegion(event) {
  const tags = Array.isArray(event?.tags) ? event.tags : [];
  const tagSlugs = tags.map((t) => String(t.slug || t.label || '')?.toLowerCase());
  const title = String(event?.title || '').toLowerCase();

  if (tagSlugs.some((s) => s.includes('us-politics')) || title.includes('us')) {
    return 'us';
  }
  return 'global';
}

/**
 * Map a Polymarket event + markets bundle into a CanonicalEvent.
 *
 * This is a pure mapping function; network calls should happen in a separate layer.
 *
 * @param {object} params
 * @param {object} params.event
 * @param {object[]} params.markets
 * @returns {import('../events-schema.mjs').CanonicalEvent}
 */
export function mapPolymarketEventToCanonical({ event, markets }) {
  if (!event || !Array.isArray(markets)) {
    throw new Error('mapPolymarketEventToCanonical: event and markets are required');
  }

  const { category, subcategory } = inferCategory(event);
  const region = inferRegion(event);

  const eventSlug =
    (typeof event.slug === 'string' && event.slug) ||
    normalizeSlug(String(event.title || event.id || 'polymarket-event'));

  /** @type {import('../events-schema.mjs').CanonicalEvent} */
  const canonicalEvent = {
    id: eventSlug,
    title: String(event.title || ''),
    category,
    subcategory,
    region,
    startTime: event.startDate || null,
    endTime: event.endDate || null,
    resolutionTime: null,
    providers: {
      [PROVIDER_IDS.POLYMARKET]: {
        provider: PROVIDER_IDS.POLYMARKET,
        eventId: String(event.id || ''),
        slug: event.slug || undefined,
      },
    },
    markets: [],
  };

  canonicalEvent.markets = markets.map((market) => {
    const question = String(market.question || '');

    // Heuristic: candidate name is "Will X be ..." → X
    let candidateName = '';
    const m = question.match(/Will (.+?) be /i);
    if (m) {
      candidateName = m[1].trim();
    }

    const marketSlugBase = candidateName || market.slug || question || market.id;
    const marketSlug = normalizeSlug(String(marketSlugBase));
    const marketId = `${canonicalEvent.id}/${marketSlug || normalizeSlug(String(market.id || 'market'))}`;

    const outcomes = parseJsonArray(market.outcomes);
    const shortOutcomes = parseJsonArray(market.shortOutcomes);
    const clobTokenIds = parseJsonArray(market.clobTokenIds);

    const yesLabel = shortOutcomes[0] || outcomes[0] || 'Yes';
    const noLabel = shortOutcomes[1] || outcomes[1] || 'No';

    /** @type {import('../events-schema.mjs').CanonicalMarket} */
    const canonicalMarket = {
      id: marketId,
      eventId: canonicalEvent.id,
      type: 'binary',
      title: question || canonicalEvent.title,
      category,
      subcategory,
      region,
      tradeOpenAt: market.startDate || null,
      tradeCloseAt: market.endDate || null,
      expectedResolveAt: null,
      latestResolveAt: null,
      outcomes: [],
      providers: {
        [PROVIDER_IDS.POLYMARKET]: {
          provider: PROVIDER_IDS.POLYMARKET,
          marketId: String(market.conditionId || market.id || ''),
          slug: market.slug || undefined,
          eventId: String(event.id || ''),
        },
      },
    };

    canonicalMarket.outcomes = [
      {
        id: `${marketId}-yes`,
        marketId,
        label: yesLabel,
        role: 'yes',
        providers: {
          [PROVIDER_IDS.POLYMARKET]: {
            provider: PROVIDER_IDS.POLYMARKET,
            outcomeId: `${market.conditionId || market.id}-YES`,
            tokenId: clobTokenIds[0] || undefined,
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
          [PROVIDER_IDS.POLYMARKET]: {
            provider: PROVIDER_IDS.POLYMARKET,
            outcomeId: `${market.conditionId || market.id}-NO`,
            tokenId: clobTokenIds[1] || undefined,
            side: 'NO',
          },
        },
      },
    ];

    return canonicalMarket;
  });

  return canonicalEvent;
}

