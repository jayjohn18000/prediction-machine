/**
 * PMCI matching adapters: classify provider markets into templates and
 * extract normalized fields for blocking and feature logging.
 *
 * Market shape (expected subset of pmci.provider_markets):
 *   {
 *     provider_market_ref,
 *     title,
 *     category,
 *     metadata,
 *     event_ref,
 *     close_time,
 *   }
 */

const US_STATE_NAMES_TO_CODE = new Map(
  [
    ['alabama', 'al'],
    ['alaska', 'ak'],
    ['arizona', 'az'],
    ['arkansas', 'ar'],
    ['california', 'ca'],
    ['colorado', 'co'],
    ['connecticut', 'ct'],
    ['delaware', 'de'],
    ['florida', 'fl'],
    ['georgia', 'ga'],
    ['hawaii', 'hi'],
    ['idaho', 'id'],
    ['illinois', 'il'],
    ['indiana', 'in'],
    ['iowa', 'ia'],
    ['kansas', 'ks'],
    ['kentucky', 'ky'],
    ['louisiana', 'la'],
    ['maine', 'me'],
    ['maryland', 'md'],
    ['massachusetts', 'ma'],
    ['michigan', 'mi'],
    ['minnesota', 'mn'],
    ['mississippi', 'ms'],
    ['missouri', 'mo'],
    ['montana', 'mt'],
    ['nebraska', 'ne'],
    ['nevada', 'nv'],
    ['new hampshire', 'nh'],
    ['new jersey', 'nj'],
    ['new mexico', 'nm'],
    ['new york', 'ny'],
    ['north carolina', 'nc'],
    ['north dakota', 'nd'],
    ['ohio', 'oh'],
    ['oklahoma', 'ok'],
    ['oregon', 'or'],
    ['pennsylvania', 'pa'],
    ['rhode island', 'ri'],
    ['south carolina', 'sc'],
    ['south dakota', 'sd'],
    ['tennessee', 'tn'],
    ['texas', 'tx'],
    ['utah', 'ut'],
    ['vermont', 'vt'],
    ['virginia', 'va'],
    ['washington', 'wa'],
    ['west virginia', 'wv'],
    ['wisconsin', 'wi'],
    ['wyoming', 'wy'],
  ].map(([name, code]) => [name, code]),
);

const US_STATE_CODES = new Set(
  [
    'al','ak','az','ar','ca','co','ct','de','fl','ga','hi','id','il','in','ia','ks','ky','la','me',
    'md','ma','mi','mn','ms','mo','mt','ne','nv','nh','nj','nm','ny','nc','nd','oh','ok','or','pa',
    'ri','sc','sd','tn','tx','ut','vt','va','wa','wv','wi','wy',
  ],
);

const COUNTRY_KEYWORDS = new Map(
  [
    ['iran', 'iran'],
    ['venezuela', 'venezuela'],
    ['russia', 'russia'],
    ['ukraine', 'ukraine'],
    ['china', 'china'],
    ['turkey', 'turkey'],
    ['israel', 'israel'],
  ],
);

function toLower(str) {
  return String(str || '').toLowerCase();
}

function combinedText(market) {
  const title = String(market?.title || '');
  const ref = String(market?.provider_market_ref || '');
  const eventRef = String(market?.event_ref || '');
  return `${title} ${ref} ${eventRef}`.replace(/#/g, ' ');
}

function extractYearFromText(text) {
  const m = text.match(/\b(20[2-9][0-9])\b/);
  return m ? Number(m[1]) : null;
}

function detectJurisdiction(market) {
  const text = combinedText(market).toLowerCase();

  if (/\b(us|u\.s\.|united states|federal|white house|senate|congress)\b/.test(text)) {
    return 'us-federal';
  }

  for (const code of US_STATE_CODES) {
    const re = new RegExp(`\\b${code}\\b`, 'i');
    if (re.test(text)) return `us-${code.toLowerCase()}`;
  }

  for (const [name, code] of US_STATE_NAMES_TO_CODE.entries()) {
    const re = new RegExp(`\\b${name}\\b`, 'i');
    if (re.test(text)) return `us-${code}`;
  }

  for (const [kw, slug] of COUNTRY_KEYWORDS.entries()) {
    if (text.includes(kw)) return `intl-${slug}`;
  }

  return null;
}

function extractCycle(market) {
  const text = combinedText(market).toLowerCase();
  const year = extractYearFromText(text);
  if (year) return year;
  if (text.includes('midterm')) return 2026;
  if (text.includes('presidential')) return 2028;
  return null;
}

function parsePolyOutcome(market) {
  const ref = String(market?.provider_market_ref || '');
  const parts = ref.split('#');
  const outcomeName = parts[1] || null;
  return { outcomeName };
}

function detectParty(market, venue) {
  const text = combinedText(market).toLowerCase();
  let outcomeName = '';
  if (venue === 'polymarket') {
    outcomeName = toLower(parsePolyOutcome(market).outcomeName);
  }
  if (outcomeName.includes('democrat') || text.includes('democrat')) return 'democrat';
  if (outcomeName.includes('republican') || text.includes('republican')) return 'republican';
  return null;
}

function extractCandidateName(market, venue, template) {
  if (template !== 'election-winner-binary' && template !== 'primary-nominee') return null;
  const ref = String(market?.provider_market_ref || '');
  if (venue === 'polymarket') {
    const { outcomeName } = parsePolyOutcome(market);
    return outcomeName || null;
  }
  const parts = ref.split('-');
  if (parts.length >= 2) {
    return parts[parts.length - 1] || null;
  }
  return null;
}

/**
 * Classify a provider market into a template type.
 *
 * @param {object} market - pmci.provider_markets row (subset)
 * @param {string} venue - 'kalshi' | 'polymarket'
 * @returns {string} template name
 */
export function classifyMarketTemplate(market, venue) {
  const text = combinedText(market).toLowerCase();
  const { outcomeName } = parsePolyOutcome(market);
  const outcome = toLower(outcomeName);

  const hasElectionKeyword =
    /\b(win|winner|nominee|primary|election|presidential)\b/.test(text);

  if (venue === 'polymarket' && outcomeName) {
    if (hasElectionKeyword && /#.+/.test(String(market?.provider_market_ref || ''))) {
      return 'election-winner-binary';
    }
  }

  if (venue === 'kalshi' && hasElectionKeyword && /\bwill\b/.test(text)) {
    return 'election-winner-binary';
  }

  const hasPartyContext = /\bparty\b/.test(text) || /\bcontrol\b/.test(text);
  if (hasPartyContext && (outcome === 'democrat' || outcome === 'republican' || outcome === 'yes')) {
    return 'election-party-binary';
  }

  const hasPrimaryOrNominee = /\b(primary|nominee)\b/.test(text);
  const hasJurisdiction = !!detectJurisdiction(market);
  if (hasPrimaryOrNominee && hasJurisdiction) {
    return 'primary-nominee';
  }

  if (
    /\b(shutdown|debt ceiling|rate decision|fed)\b/.test(text)
  ) {
    return 'policy-event';
  }

  if (
    /\b(iran|venezuela|strait|strike|supreme leader)\b/.test(text)
  ) {
    return 'geopolitical-event';
  }

  return 'unknown';
}

/**
 * Extract key matching fields for a market given its template.
 *
 * @param {object} market - pmci.provider_markets row (subset)
 * @param {string} venue - 'kalshi' | 'polymarket'
 * @returns {object} shape:
 *   { template, jurisdiction, cycle, party, candidateName, resolutionYear, thresholdValue, thresholdAsset }
 */
export function extractMatchingFields(market, venue) {
  const template = classifyMarketTemplate(market, venue);
  const jurisdiction = detectJurisdiction(market);
  const cycle = extractCycle(market);
  const party = detectParty(market, venue);
  const candidateName = extractCandidateName(market, venue, template);

  let resolutionYear = null;
  if (cycle) {
    resolutionYear = cycle;
  } else if (market?.close_time) {
    const d = new Date(market.close_time);
    if (!Number.isNaN(d.getTime())) resolutionYear = d.getUTCFullYear();
  }

  return {
    template,
    jurisdiction,
    cycle,
    party,
    candidateName,
    resolutionYear,
    thresholdValue: null,
    thresholdAsset: null,
  };
}

