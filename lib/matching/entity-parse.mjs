/**
 * Entity normalization, race-token extraction, and per-venue market parsing for PMCI matching.
 * Pure functions — no database access.
 *
 * Extracted from proposal-engine.mjs (Step 5 decomposition).
 */

import { tokenize } from './scoring.mjs';

/** Synonym normalization so GOP/Republican, Dem/Democratic match before entity gate. */
export const SYNONYM_MAP = {
  gop: 'republican', dem: 'democratic', democrat: 'democratic', democrats: 'democratic',
  republicans: 'republican', "gop's": 'republican',
  pm: 'prime minister', sen: 'senator', gov: 'governor', rep: 'representative', pres: 'president',
  atty: 'attorney', ag: 'attorney general',
};

export const ENTITY_STOPWORDS = new Set([
  'will', 'be', 'the', 'a', 'an', 'for', 'to', 'of', 'in', 'on', 'at', 'by', 'as',
  'nominee', 'nomination', 'presidential', 'democratic', 'republican', 'party', 'win', 'election', 'primary',
]);

export const ENTITY_SUFFIXES = /\s+(jr\.?|sr\.?|ii|iii|iv|v)\s*$/i;

/** District: GA-14, NY-21, MI-10, TX-15. Chamber+state: Senate NV, House AZ 1st. */
export const DISTRICT_PATTERN = /\b([A-Za-z]{2})-?(\d{1,2})\b/g;
export const SENATE_STATE_PATTERN = /senate\s+([A-Za-z]{2})\b|\b([A-Za-z]{2})\s+senate\s+(?:race|seat|election)/gi;
export const HOUSE_STATE_PATTERN = /house\s+([A-Za-z]{2})\b|(?:house\s+)?([A-Za-z]{2})\s*\d|\b([A-Za-z]{2})-?\d{1,2}\s*(?:house|district)/gi;

/** Generic outcome placeholders: Person F, Individual X, Party B — fail proxy entity gate. */
export const GENERIC_ENTITY_PATTERN = /^(person|individual|party)\s*[a-z]?$/i;
export const GENERIC_ENTITY_LEADING = /^(person|individual|party)\s+[a-z]\s*$/i;

export function normalizeTitle(title) {
  if (!title || typeof title !== 'string') return '';
  return title
    .toLowerCase()
    .replace(/\b(\w+)\b/g, (w) => SYNONYM_MAP[w] ?? w);
}

/**
 * Normalize entity name for fuzzy matching: lowercase, strip punctuation, remove stopwords and suffixes, collapse whitespace.
 * @param {string} name
 * @returns {string}
 */
export function normalizeEntity(name) {
  if (!name || typeof name !== 'string') return '';
  let s = name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(ENTITY_SUFFIXES, '')
    .replace(/\s+/g, ' ')
    .trim();
  const tokens = s.split(/\s+/).filter((t) => t.length > 1 && !ENTITY_STOPWORDS.has(t));
  return tokens.join(' ');
}

/**
 * Extract last token as last name for matching (e.g. "donald trump" -> "trump").
 * @param {string} normalizedEntity
 * @returns {string}
 */
export function getLastName(normalizedEntity) {
  const tokens = normalizedEntity.split(/\s+/).filter(Boolean);
  return tokens.length ? tokens[tokens.length - 1] : '';
}

export function isGenericEntity(normalizedEntity, rawEntity = '') {
  if (!normalizedEntity || normalizedEntity.length < 2) return true;
  const norm = normalizedEntity.trim();
  if (GENERIC_ENTITY_PATTERN.test(norm)) return true;
  if (GENERIC_ENTITY_LEADING.test(norm)) return true;
  const raw = String(rawEntity).trim().toLowerCase();
  if (GENERIC_ENTITY_PATTERN.test(raw)) return true;
  if (/^(person|individual|party)\s+[a-z]\s*$/.test(raw)) return true;
  const tokens = norm.split(/\s+/).filter(Boolean);
  if (tokens.length === 1 && tokens[0].length === 1) return true;
  if (tokens.length >= 1 && /^(person|individual|party)$/i.test(tokens[0]) && (tokens.length === 1 || (tokens.length === 2 && tokens[1].length <= 2))) return true;
  return false;
}

/**
 * Extract race tokens for election/seat markets: district (ga14), chamber+state (senate-nv, house-az).
 * @param {string} text - title or ref
 * @returns {string[]}
 */
export function extractRaceTokens(text) {
  if (!text || typeof text !== 'string') return [];
  const combined = text.replace(/#/g, ' ');
  const out = new Set();
  let m;
  const districtRe = new RegExp(DISTRICT_PATTERN.source, 'g');
  while ((m = districtRe.exec(combined)) !== null) {
    out.add(`${m[1].toLowerCase()}${m[2]}`);
  }
  const senateRe = new RegExp(SENATE_STATE_PATTERN.source, 'gi');
  while ((m = senateRe.exec(combined)) !== null) {
    const state = (m[1] || m[2] || '').toLowerCase();
    if (state.length === 2) out.add(`senate-${state}`);
  }
  const houseRe = new RegExp(HOUSE_STATE_PATTERN.source, 'gi');
  while ((m = houseRe.exec(combined)) !== null) {
    const state = (m[1] || m[2] || m[3] || '').toLowerCase();
    if (state.length === 2) out.add(`house-${state}`);
  }
  return [...out];
}

/** Returns true when outcomeName is a numeric condition ID or a generic Yes/No placeholder. */
export function isNumericOrGenericOutcome(s) {
  if (!s) return true;
  const t = s.trim();
  if (/^\d+$/.test(t)) return true;
  if (/^(yes|no)(\s+\d+)?$/i.test(t)) return true;
  return false;
}

/**
 * Entity similarity gate: race-token overlap (election) OR last-name match OR token Jaccard >= 0.5 OR prefix overlap.
 * @param {{ normalizedEntity?: string, entityTokens?: string[], raceTokens?: string[] }} a
 * @param {{ normalizedEntity?: string, entityTokens?: string[], raceTokens?: string[] }} b
 * @returns {boolean}
 */
export function entitySimilarityPass(a, b) {
  // Election/race: if both have race tokens (district, senate-nv, house-az), match on any overlap
  const raceA = a?.raceTokens || [];
  const raceB = b?.raceTokens || [];
  if (raceA.length && raceB.length) {
    const setB = new Set(raceB);
    for (const t of raceA) if (setB.has(t)) return true;
  }

  if (!a?.normalizedEntity && !b?.normalizedEntity) return true;
  if (!a?.normalizedEntity || !b?.normalizedEntity) return false;
  const lastA = getLastName(a.normalizedEntity);
  const lastB = getLastName(b.normalizedEntity);
  if (lastA && lastB && lastA === lastB) return true;
  const setA = new Set((a.entityTokens || []).filter((t) => t.length > 1));
  const setB = new Set((b.entityTokens || []).filter((t) => t.length > 1));
  if (setA.size && setB.size) {
    let inter = 0;
    for (const x of setA) if (setB.has(x)) inter += 1;
    const union = setA.size + setB.size - inter;
    if (union > 0 && inter / union >= 0.5) return true;
    if (inter >= 1 && (lastA && lastB && lastA.slice(0, 2) === lastB.slice(0, 2))) return true;
  }
  const preA = a.normalizedEntity.slice(0, 4);
  const preB = b.normalizedEntity.slice(0, 4);
  if (preA && preB && (a.normalizedEntity.startsWith(preB) || b.normalizedEntity.startsWith(preA))) return true;
  return false;
}

/**
 * Parse Polymarket ref: slug#outcomeName → entity from outcomeName (normalized for fuzzy match).
 * When outcomeName is a numeric condition ID or generic Yes/No, falls back to title-based
 * "Will [Name] win/be..." extraction so universe-ingested markets can match Kalshi by entity.
 * Includes race tokens from slug/ref.
 *
 * @param {string} ref - Polymarket provider_market_ref (slug#outcomeName format)
 * @param {string} [title]
 * @param {Set<string>} [politicsTopicTokens] - topic token set for filtering topicTokens (optional)
 */
export function parsePolyRef(ref, title = '', politicsTopicTokens = null) {
  const refStr = String(ref || '');
  const parts = refStr.split('#');
  const slug = parts[0] || '';
  const outcomeName = parts[1] || '';
  const slugTokens = tokenize(slug.replace(/-/g, ' '));
  let rawEntity = normalizeTitle(outcomeName || '');
  if (isNumericOrGenericOutcome(outcomeName)) {
    // Fall back to title-based entity extraction for universe-ingested markets
    // whose outcomeName is a numeric condition ID (e.g. "559659") or Yes/No.
    const titleStr = normalizeTitle(String(title || ''));
    const willMatch = titleStr.match(/will\s+(.+?)\s+(?:be|win)\b/i);
    if (willMatch?.[1]) {
      rawEntity = willMatch[1].trim();
    } else {
      rawEntity = slugTokens[0] || '';
    }
  }
  let normalizedEntity = normalizeEntity(rawEntity);
  // If normalization strips the entity entirely (e.g. "Republican"/"Democrat" are in ENTITY_STOPWORDS
  // for candidate-name stripping), fall back to lowercased rawEntity so party-level markets
  // can match each other through the entity gate.
  if (!normalizedEntity && rawEntity) normalizedEntity = rawEntity.toLowerCase().trim();
  const entityTokens = normalizedEntity ? normalizedEntity.split(/\s+/).filter(Boolean) : [];
  const entityKey = entityTokens[0] || slugTokens[0] || 'unknown';
  const raceTokens = extractRaceTokens(`${String(title)} ${refStr}`);
  return {
    slug,
    outcomeName,
    slugTokens,
    entityKey,
    normalizedEntity,
    entityTokens,
    raceTokens,
  };
}

/**
 * Parse Kalshi title: "Will <NAME> be ..." via regex, then normalize; fallback token-based.
 * Includes race tokens for election/seat markets.
 *
 * @param {string} ref - Kalshi provider_market_ref (ticker)
 * @param {string} title
 * @param {Set<string>} [politicsTopicTokens] - topic token set for filtering topicTokens
 */
export function parseKalshiTitle(ref, title, politicsTopicTokens = null) {
  const raw = normalizeTitle(String(title || ''));
  const refStr = String(ref || '');
  let rawEntity = '';
  const willMatch = raw.match(/will\s+(.+?)\s+be\b/i);
  if (willMatch?.[1]) {
    rawEntity = willMatch[1].trim();
  } else {
    const tokens = tokenize(raw);
    const willIdx = tokens.findIndex((t) => t === 'will');
    rawEntity = willIdx >= 0 && tokens[willIdx + 1] ? tokens[willIdx + 1] : tokens[0] || refStr || '';
  }
  let normalizedEntity = normalizeEntity(rawEntity);
  // If normalization strips the entity entirely (e.g. "Republicans"/"Democrats" in ENTITY_STOPWORDS),
  // fall back to lowercased rawEntity to preserve party-level matching.
  if (!normalizedEntity && rawEntity) normalizedEntity = rawEntity.toLowerCase().trim();
  const tokens = tokenize(raw);
  const topicTokens = politicsTopicTokens
    ? tokens.filter((t) => politicsTopicTokens.has(t))
    : [];
  const entityTokens = normalizedEntity ? normalizedEntity.split(/\s+/).filter(Boolean) : [];
  const entityKey = entityTokens[0] || tokens[0] || 'unknown';
  const raceTokens = extractRaceTokens(`${raw} ${refStr}`);
  return {
    entityKey,
    titleTokens: tokens,
    topicTokens,
    normalizedEntity,
    entityTokens,
    raceTokens,
    rawEntity,
    outcomeName: rawEntity || null,
  };
}
