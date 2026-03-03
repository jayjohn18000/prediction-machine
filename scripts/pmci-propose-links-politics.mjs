#!/usr/bin/env node
/**
 * PMCI Phase 2: Propose equivalent and proxy links for politics (Kalshi ↔ Polymarket).
 * LINKER_PROPOSER: blocking + heuristics, caps, auto-accept high-confidence equivalent.
 * Env: DATABASE_URL, PMCI_MAX_PROPOSALS_EQUIV (default 200), PMCI_MAX_PROPOSALS_PROXY (default 200),
 *      PMCI_MAX_PER_BLOCK (default 50).
 */

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const { Client } = pg;

const PMCI_MAX_PROPOSALS_EQUIV = Number(process.env.PMCI_MAX_PROPOSALS_EQUIV || '200');
const PMCI_MAX_PROPOSALS_PROXY = Number(process.env.PMCI_MAX_PROPOSALS_PROXY || '200');
const PMCI_MAX_PER_BLOCK = Number(process.env.PMCI_MAX_PER_BLOCK || '50');

const CATEGORY = 'politics';

// Politics topic tokens (for blocking and proxy guardrail)
const POLITICS_TOPIC_TOKENS = new Set([
  'fed', 'chair', 'shutdown', 'nuclear', 'deal', 'nominee', 'senate', 'house', 'election',
  'impeachment', 'presidential', 'democratic', 'republican', 'primary', 'nomination',
  '2028', '2026', 'governor', 'congress', 'vote', 'win', 'will',
]);

/** Shared politics keywords for proxy keyword_overlap_score (travel across venues). */
const PROXY_POLITICS_KEYWORDS = new Set([
  'fed', 'chair', 'nominee', 'ban', 'tariff', 'meet', 'putin', 'zelenskyy', 'shutdown',
  'nuclear', 'deal', 'senate', 'house', 'election', 'presidential', 'democratic', 'republican',
  'primary', '2028', '2026', 'governor', 'congress', 'impeachment',
]);

/** Maps title/slug/ref text to a small canonical topic key for blocking. Order matters: more specific first. */
const TOPIC_KEY_PATTERNS = [
  [/fed\s*chair|chair\s*fed|federal\s*reserve\s*chair|powell\s*(leave|stay|chair)/i, 'fed_chair'],
  [/government\s*shutdown|shutdown\s*government/i, 'shutdown'],
  [/supreme\s*court|scotus/i, 'supreme_court'],
  [/nuclear\s*deal|iran\s*nuclear|nuclear\s*agreement/i, 'nuclear_deal'],
  [/impeach(ment)?/i, 'impeachment'],
  [/trump\s*banned|banned\s*on\s*x|x\s*ban|twitter\s*ban/i, 'x_ban'],
  [/trump\s*nominate|nominate\s*fbi|fbi\s*director|appointments?|cabinet\s*(pick|nominee)/i, 'appointments'],
  [/russia\s*deal|venezuela|turkey\s*election|international|ukraine|zelenskyy|putin\s*meet/i, 'international'],
  [/tariffs?|trade\s*war|china\s*tariff/i, 'tariffs'],
  [/tax\s*(cut|reform|plan)/i, 'tax'],
  [/trump\s*(zelenskyy|putin|meet|meeting)|meeting\s*(putin|zelenskyy)/i, 'meetings'],
  [/harvard\s*apps?|education\s*politics|college\s*admission/i, 'education'],
  [/presidential\s*nominee|nominee\s*2028|nomination\s*20\d{2}|democratic\s*nominee|republican\s*nominee/i, 'nominee'],
  [/senate\s*(race|election|seat|control)|control\s*of\s*senate|senate\s*(nv|az|mi|ga|pa|oh|wi|fl)/i, 'senate'],
  [/house\s*(race|election|seat|control)|control\s*of\s*the\s*house|house\s*(nv|az|mi|ga|pa|district)/i, 'house'],
  [/governor\s*(race|election)|gubernatorial/i, 'governor'],
  [/congress(ional)?\s*(election|control)/i, 'congress'],
  [/presidential\s*election|election\s*20\d{2}|president\s*20\d{2}|primary\s*20\d{2}/i, 'election'],
];

const DEFAULT_TOPIC_KEY = 'other';

const ENTITY_STOPWORDS = new Set([
  'will', 'be', 'the', 'a', 'an', 'for', 'to', 'of', 'in', 'on', 'at', 'by', 'as',
  'nominee', 'nomination', 'presidential', 'democratic', 'republican', 'party', 'win', 'election', 'primary',
]);

const ENTITY_SUFFIXES = /\s+(jr\.?|sr\.?|ii|iii|iv|v)\s*$/i;

/** District: GA-14, NY-21, MI-10, TX-15. Chamber+state: Senate NV, House AZ 1st. */
const DISTRICT_PATTERN = /\b([A-Za-z]{2})-?(\d{1,2})\b/g;
const SENATE_STATE_PATTERN = /senate\s+([A-Za-z]{2})\b|\b([A-Za-z]{2})\s+senate\s+(?:race|seat|election)/gi;
const HOUSE_STATE_PATTERN = /house\s+([A-Za-z]{2})\b|(?:house\s+)?([A-Za-z]{2})\s*\d|\b([A-Za-z]{2})-?\d{1,2}\s*(?:house|district)/gi;

/** US state 2-letter codes (lowercase) for signature geography. */
const US_STATES = new Set(
  'al,ak,az,ar,ca,co,ct,de,fl,ga,hi,id,il,in,ia,ks,ky,la,me,md,ma,mi,mn,ms,mo,mt,ne,nv,nh,nj,nm,ny,nc,nd,oh,ok,or,pa,ri,sc,sd,tn,tx,ut,vt,va,wa,wv,wi,wy,dc'.split(','),
);

/** Generic outcome placeholders: Person F, Individual X, Party B — fail proxy entity gate. */
const GENERIC_ENTITY_PATTERN = /^(person|individual|party)\s*[a-z]?$/i;
const GENERIC_ENTITY_LEADING = /^(person|individual|party)\s+[a-z]\s*$/i;
function isGenericEntity(normalizedEntity, rawEntity = '') {
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
function extractRaceTokens(text) {
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

/**
 * Normalize entity name for fuzzy matching: lowercase, strip punctuation, remove stopwords and suffixes, collapse whitespace.
 * @param {string} name
 * @returns {string}
 */
function normalizeEntity(name) {
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
function getLastName(normalizedEntity) {
  const tokens = normalizedEntity.split(/\s+/).filter(Boolean);
  return tokens.length ? tokens[tokens.length - 1] : '';
}

/**
 * Entity similarity gate: race-token overlap (election) OR last-name match OR token Jaccard >= 0.5 OR prefix overlap.
 * @param {{ normalizedEntity?: string, entityTokens?: string[], raceTokens?: string[] }} a
 * @param {{ normalizedEntity?: string, entityTokens?: string[], raceTokens?: string[] }} b
 * @returns {boolean}
 */
function entitySimilarityPass(a, b) {
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
 * Extract a single topic key from market title/slug/ref for blocking.
 * Returns one of: fed_chair, shutdown, supreme_court, nuclear_deal, impeachment, x_ban, appointments, international, tariffs, tax, meetings, education, nominee, senate, house, governor, congress, election, other.
 * @param {{ title?: string, provider_market_ref?: string }} market - has title and ref (Kalshi ticker or Poly slug#outcome)
 * @returns {string}
 */
function extractTopicKey(market) {
  const title = String(market?.title || '');
  const ref = String(market?.provider_market_ref || '');
  const combined = `${title} ${ref}`.replace(/#/g, ' ');
  // Robust nominee classification: title/slug contains nominee|primary|presidential|2028 => nominee
  if (/\b(nominee|primary|presidential|2028)\b/i.test(combined)) return 'nominee';
  for (const [re, key] of TOPIC_KEY_PATTERNS) {
    if (re.test(combined)) return key;
  }
  return DEFAULT_TOPIC_KEY;
}

/**
 * Topic signature for blocking: office + geography + year (and optional district/special).
 * Only compare within same signature. Returns null for non-election topics (use topic_key as block then).
 * @param {{ title?: string, provider_market_ref?: string }} market
 * @returns {string | null} e.g. pres_nominee_us_2028, senate_tx_2026, house_ga14_2026_special, mayor_ann_arbor_2026
 */
function extractTopicSignature(market) {
  const title = String(market?.title || '');
  const ref = String(market?.provider_market_ref || '');
  const combined = `${title} ${ref}`.replace(/#/g, ' ').replace(/-/g, ' ').toLowerCase();
  const yearMatch = combined.match(/\b(2024|2026|2028)\b/);
  const year = yearMatch ? yearMatch[1] : null;

  const special = /\bspecial\s*(election|race)?\b/.test(combined) ? '_special' : '';

  // Governor + state — check BEFORE presidential nominee so "Republican nominee for Governor in Iowa"
  // is classified as governor_ia_2026, not pres_nominee_us_2028.
  if (/\b(governor|gubernatorial)\b/.test(combined)) {
    const govState = [...combined.matchAll(/\b(governor|gubernatorial)\b.*?\b([a-z]{2})\b|\b([a-z]{2})\s*(?:governor|gubernatorial)/gi)].find(() => true);
    const state = (govState?.[2] || govState?.[3] || '').toLowerCase();
    if (state && US_STATES.has(state)) return `governor_${state}_${year || '2026'}${special}`;
    return `governor_unknown_${year || '2026'}${special}`;
  }

  // Senate + state — check BEFORE presidential nominee so "Democratic nominee for the Senate in Maine"
  // is classified as senate_me_2026, not pres_nominee_us_2028.
  const senateState = [...combined.matchAll(/\b(senate|sen)\b.*?\b([a-z]{2})\b|([a-z]{2})\s*senate/gi)].find(() => true);
  const senateStateCode = senateState ? (senateState[2] || senateState[3] || '').toLowerCase() : null;
  if ((/senate\s*(race|election|seat|control)/.test(combined) || ref.includes('SENATE')) && senateStateCode && US_STATES.has(senateStateCode)) {
    return `senate_${senateStateCode}_${year || '2026'}${special}`;
  }
  if (/senate\s*(race|election|seat)/.test(combined)) {
    const dist = [...combined.matchAll(/\b([a-z]{2})-?(\d{1,2})\b/g)];
    const stateFromDist = dist[0]?.[1]?.toLowerCase();
    if (stateFromDist && US_STATES.has(stateFromDist)) return `senate_${stateFromDist}_${year || '2026'}${special}`;
  }

  // Presidential nominee (US only; governor/senate nominees already handled above)
  if (/\b(presidential\s*nominee|nominee\s*2028|democratic\s*nominee|republican\s*nominee|presidential\s*primary)\b/.test(combined)) {
    const y = year || '2028';
    return `pres_nominee_us_${y}`;
  }

  // House + district or state
  const houseDist = [...combined.matchAll(/\b([a-z]{2})-?(\d{1,2})\b/g)];
  const houseState = [...combined.matchAll(/\b(house|rep)\b.*?\b([a-z]{2})\b|([a-z]{2})\s*house|house\s*([a-z]{2})\b/gi)].find(() => true);
  if ((/house\s*(race|election|seat|control|district)/.test(combined) || ref.includes('HOUSE')) && houseDist.length > 0) {
    const d = houseDist[0];
    const state = (d[1] || '').toLowerCase();
    const num = (d[2] || '').toLowerCase();
    if (state && US_STATES.has(state)) return `house_${state}${num}_${year || '2026'}${special}`;
  }
  if (/house\s*(race|election|seat)/.test(combined) && houseState) {
    const state = (houseState[2] || houseState[3] || houseState[4] || '').toLowerCase();
    if (state && US_STATES.has(state)) return `house_${state}_${year || '2026'}${special}`;
  }

  // Mayor + city (slug often has city: ann-arbor-mayor, austin-mayor)
  if (/\bmayor\b/.test(combined)) {
    const slugPart = ref.split('#')[0] || '';
    const slugTokens = slugPart.toLowerCase().replace(/-/g, ' ').split(/\s+/);
    const mayorIdx = slugTokens.findIndex((t) => t === 'mayor');
    const cityTokens = mayorIdx > 0 ? slugTokens.slice(0, mayorIdx) : slugTokens.filter((t) => t !== 'mayor' && t.length > 1);
    const city = (cityTokens.slice(0, 2).join('_') || 'unknown').replace(/\s+/g, '_');
    return `mayor_${city}_${year || '2026'}${special}`;
  }

  // Congress (generic)
  if (/\bcongress(ional)?\s*(election|control)\b/.test(combined)) {
    return `congress_us_${year || '2026'}${special}`;
  }

  return null;
}

function loadEnv() {
  const envPath = path.join(process.cwd(), '.env');
  try {
    const env = fs.readFileSync(envPath, 'utf8');
    env.split('\n').forEach((line) => {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
    });
  } catch (_) {}
}
loadEnv();

function tokenize(s) {
  if (!s || typeof s !== 'string') return [];
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^-|-$/g, ''))
    .filter((t) => t.length > 1);
}

/** Returns true when outcomeName is a numeric condition ID or a generic Yes/No placeholder. */
function isNumericOrGenericOutcome(s) {
  if (!s) return true;
  const t = s.trim();
  if (/^\d+$/.test(t)) return true;
  if (/^(yes|no)(\s+\d+)?$/i.test(t)) return true;
  return false;
}

/** Polymarket ref: slug#outcomeName → entity from outcomeName (normalized for fuzzy match).
 *  When outcomeName is a numeric condition ID or generic Yes/No, falls back to title-based
 *  "Will [Name] win/be..." extraction so universe-ingested markets can match Kalshi by entity.
 *  Includes race tokens from slug/ref. */
function parsePolyRef(ref, title = '') {
  const refStr = String(ref || '');
  const parts = refStr.split('#');
  const slug = parts[0] || '';
  const outcomeName = parts[1] || '';
  const slugTokens = tokenize(slug.replace(/-/g, ' '));
  let rawEntity = outcomeName || '';
  if (isNumericOrGenericOutcome(outcomeName)) {
    // Fall back to title-based entity extraction for universe-ingested markets
    // whose outcomeName is a numeric condition ID (e.g. "559659") or Yes/No.
    const titleStr = String(title || '');
    const willMatch = titleStr.match(/Will\s+(.+?)\s+(?:be|win)\b/i);
    if (willMatch?.[1]) {
      rawEntity = willMatch[1].trim();
    } else {
      rawEntity = slugTokens[0] || '';
    }
  }
  const normalizedEntity = normalizeEntity(rawEntity);
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

/** Kalshi title: "Will <NAME> be ..." via regex, then normalize; fallback token-based. Includes race tokens for election/seat markets. */
function parseKalshiTitle(ref, title) {
  const raw = String(title || '');
  const refStr = String(ref || '');
  let rawEntity = '';
  const willMatch = raw.match(/Will\s+(.+?)\s+be\b/i);
  if (willMatch?.[1]) {
    rawEntity = willMatch[1].trim();
  } else {
    const tokens = tokenize(raw);
    const willIdx = tokens.findIndex((t) => t === 'will');
    rawEntity = willIdx >= 0 && tokens[willIdx + 1] ? tokens[willIdx + 1] : tokens[0] || refStr || '';
  }
  const normalizedEntity = normalizeEntity(rawEntity);
  const tokens = tokenize(raw);
  const topicTokens = tokens.filter((t) => POLITICS_TOPIC_TOKENS.has(t));
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
  };
}

function jaccard(a, b) {
  if (!a?.size && !b?.size) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

function slugSimilarity(slugTokensA, slugTokensB) {
  return jaccard(new Set(slugTokensA), new Set(slugTokensB));
}

/** Keyword overlap for proxy: share of politics keywords present in either market that appear in both. */
function keywordOverlapScore(tokensA, tokensB) {
  const setA = new Set((tokensA || []).filter((t) => PROXY_POLITICS_KEYWORDS.has(t)));
  const setB = new Set((tokensB || []).filter((t) => PROXY_POLITICS_KEYWORDS.has(t)));
  if (setA.size === 0 && setB.size === 0) return 0;
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter += 1;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Equivalent: high entity + high title/slug. Proxy: less on slug_similarity; add keyword_overlap, entity_strength, topic_match, time_window. */
function scorePair(mA, mB, meta) {
  const {
    titleSim,
    slugSim,
    entityMatch,
    sharedTopics,
    keywordOverlapScore: kwScore = 0,
    entityStrength = entityMatch ? 1 : 0,
    topicMatchBonus = 0,
    timeWindowBonus = 0,
  } = meta;
  const entityScore = entityMatch ? 1 : 0;
  const equiv = 0.4 * titleSim + 0.3 * slugSim + 0.3 * entityScore;
  const equivConf = Math.min(1, equiv + (entityMatch ? 0.15 : 0) + (titleSim > 0.5 ? 0.1 : 0));
  // Proxy: rely less on slug; add topic-signature features so cross-venue pairs can clear threshold
  let proxyConf = equivConf * 0.85 + kwScore * 0.15 + entityStrength * 0.1 + topicMatchBonus + timeWindowBonus;
  if (sharedTopics && !entityMatch) proxyConf = Math.min(0.96, proxyConf + 0.1);
  return {
    equivalent_confidence: Math.round(equivConf * 10000) / 10000,
    proxy_confidence: Math.round(Math.min(0.97, proxyConf) * 10000) / 10000,
  };
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  const report = {
    proposals_written_equivalent: 0,
    proposals_written_proxy: 0,
    attach_proposals_written: 0,
    new_pair_proposals_written: 0,
    autoaccepted_equivalent: 0,
    skipped_already_linked: 0,
    skipped_low_confidence: 0,
    caps_hit_equiv: false,
    caps_hit_proxy: false,
    kalshi_unlinked_count: 0,
    polymarket_unlinked_count: 0,
    kalshi_universe_filtered: 0,
    polymarket_universe_filtered: 0,
    blocks_with_both: 0,
  };

  report.filtered_generic_entities = 0;

  try {
    const provRes = await client.query(
      `SELECT id, code FROM pmci.providers WHERE code IN ('kalshi','polymarket')`,
    );
    const byCode = new Map((provRes.rows || []).map((r) => [r.code, r.id]));
    const kalshiId = byCode.get('kalshi');
    const polyId = byCode.get('polymarket');
    if (!kalshiId || !polyId) {
      console.error('Missing kalshi or polymarket provider');
      process.exit(1);
    }

    const linkedRes = await client.query(
      `SELECT provider_market_id, family_id FROM pmci.v_market_links_current WHERE status = 'active'`,
    );
    const linkedIds = new Set();
    const marketIdToFamilyId = new Map();
    for (const r of linkedRes.rows || []) {
      const id = Number(r.provider_market_id);
      linkedIds.add(id);
      if (r.family_id != null) marketIdToFamilyId.set(id, Number(r.family_id));
    }

    const kalshiRows = await client.query(
      `SELECT id, provider_market_ref, title, event_ref, close_time, last_seen_at, metadata
       FROM pmci.provider_markets
       WHERE provider_id = $1 AND category = $2`,
      [kalshiId, CATEGORY],
    );
    const polyRows = await client.query(
      `SELECT id, provider_market_ref, title, event_ref, close_time, last_seen_at, metadata
       FROM pmci.provider_markets
       WHERE provider_id = $1 AND category = $2`,
      [polyId, CATEGORY],
    );

    const kalshiAll = kalshiRows.rows || [];
    const polyAll = polyRows.rows || [];
    report.skipped_already_linked =
      kalshiAll.filter((r) => linkedIds.has(Number(r.id))).length + polyAll.filter((r) => linkedIds.has(Number(r.id))).length;

    let kalshiUnlinked = kalshiAll.filter((r) => !linkedIds.has(Number(r.id)));
    let polyUnlinked = polyAll.filter((r) => !linkedIds.has(Number(r.id)));
    const kalshiUnlinkedCount = kalshiUnlinked.length;
    const polyUnlinkedCount = polyUnlinked.length;

    const isUniverse = (r) => r.metadata && r.metadata.mode === 'universe';
    const kalshiUniverse = kalshiUnlinked.filter(isUniverse);
    const polyUniverse = polyUnlinked.filter(isUniverse);
    const useUniverseKalshi = kalshiUniverse.length > 0;
    const useUniversePoly = polyUniverse.length > 0;
    if (useUniverseKalshi) kalshiUnlinked = kalshiUniverse;
    if (useUniversePoly) polyUnlinked = polyUniverse;
    report.kalshi_unlinked_count = kalshiUnlinked.length;
    report.polymarket_unlinked_count = polyUnlinked.length;
    report.kalshi_universe_filtered = useUniverseKalshi ? kalshiUnlinkedCount - kalshiUnlinked.length : 0;
    report.polymarket_universe_filtered = useUniversePoly ? polyUnlinkedCount - polyUnlinked.length : 0;

    const allMarketIds = [...kalshiAll.map((r) => r.id), ...polyAll.map((r) => r.id)];
    let snapshotRawByMarket = new Map();
    if (allMarketIds.length > 0) {
      const snapRes = await client.query(
        `SELECT DISTINCT ON (provider_market_id) provider_market_id, raw
         FROM pmci.provider_market_snapshots
         WHERE provider_market_id = ANY($1::bigint[])
         ORDER BY provider_market_id, observed_at DESC`,
        [allMarketIds],
      );
      for (const r of snapRes.rows || []) {
        snapshotRawByMarket.set(Number(r.provider_market_id), r.raw || {});
      }
    }

    const canonicalSlugs = new Map();
    const ceRes = await client.query(`SELECT id, slug FROM pmci.canonical_events WHERE category = $1`, [CATEGORY]);
    for (const r of ceRes.rows || []) canonicalSlugs.set(r.slug, r.id);

    function getPriceSource(pmId) {
      const raw = snapshotRawByMarket.get(Number(pmId)) || {};
      return raw?._pmci?.price_source ?? null;
    }

    // Block key = topic_signature (office+geo+year) or fallback topic_key. Compare only within same block.
    function blockKey(m) {
      const sig = extractTopicSignature({ title: m.title, provider_market_ref: m.provider_market_ref });
      return sig || extractTopicKey({ title: m.title, provider_market_ref: m.provider_market_ref });
    }

    // Source = unlinked only. Target = ALL (linked + unlinked) in same block. Attach unlinked to existing families.
    function addKalshi(block, m, list) {
      const parsed = parseKalshiTitle(m.provider_market_ref, m.title);
      const topicKey = extractTopicKey({ title: m.title, provider_market_ref: m.provider_market_ref });
      const topicSignature = extractTopicSignature({ title: m.title, provider_market_ref: m.provider_market_ref });
      const genericEntity = isGenericEntity(parsed.normalizedEntity, parsed.rawEntity || '');
      list.get(block).push({
        id: m.id,
        provider_id: kalshiId,
        ref: m.provider_market_ref,
        title: m.title,
        event_ref: m.event_ref,
        close_time: m.close_time,
        last_seen_at: m.last_seen_at,
        ...parsed,
        topicKey,
        topicSignature,
        genericEntity,
        isLinked: linkedIds.has(Number(m.id)),
        familyId: marketIdToFamilyId.get(Number(m.id)) ?? null,
      });
    }
    function addPoly(block, m, list) {
      const parsed = parsePolyRef(m.provider_market_ref, m.title);
      const topicTokens = (parsed.slugTokens || []).filter((t) => POLITICS_TOPIC_TOKENS.has(t));
      const topicKey = extractTopicKey({ title: m.title, provider_market_ref: m.provider_market_ref });
      const topicSignature = extractTopicSignature({ title: m.title, provider_market_ref: m.provider_market_ref });
      const genericEntity = isGenericEntity(parsed.normalizedEntity, parsed.outcomeName || '');
      list.get(block).push({
        id: m.id,
        provider_id: polyId,
        ref: m.provider_market_ref,
        title: m.title,
        event_ref: m.event_ref,
        close_time: m.close_time,
        last_seen_at: m.last_seen_at,
        ...parsed,
        slugTokens: parsed.slugTokens,
        topicTokens,
        topicKey,
        topicSignature,
        genericEntity,
        isLinked: linkedIds.has(Number(m.id)),
        familyId: marketIdToFamilyId.get(Number(m.id)) ?? null,
      });
    }

    const kalshiUnlinkedByBlock = new Map();
    const kalshiAllByBlock = new Map();
    const polyUnlinkedByBlock = new Map();
    const polyAllByBlock = new Map();
    for (const m of kalshiUnlinked) {
      const block = blockKey(m);
      if (!kalshiUnlinkedByBlock.has(block)) kalshiUnlinkedByBlock.set(block, []);
      addKalshi(block, m, kalshiUnlinkedByBlock);
    }
    for (const m of kalshiAll) {
      const block = blockKey(m);
      if (!kalshiAllByBlock.has(block)) kalshiAllByBlock.set(block, []);
      addKalshi(block, m, kalshiAllByBlock);
    }
    for (const m of polyUnlinked) {
      const block = blockKey(m);
      if (!polyUnlinkedByBlock.has(block)) polyUnlinkedByBlock.set(block, []);
      addPoly(block, m, polyUnlinkedByBlock);
    }
    for (const m of polyAll) {
      const block = blockKey(m);
      if (!polyAllByBlock.has(block)) polyAllByBlock.set(block, []);
      addPoly(block, m, polyAllByBlock);
    }

    const blockKeys = new Set([...kalshiAllByBlock.keys(), ...polyAllByBlock.keys()]);
    const blocksWithBoth = [...blockKeys].filter(
      (b) =>
        ((kalshiUnlinkedByBlock.get(b)?.length ?? 0) > 0 && (polyAllByBlock.get(b)?.length ?? 0) > 0) ||
        ((polyUnlinkedByBlock.get(b)?.length ?? 0) > 0 && (kalshiAllByBlock.get(b)?.length ?? 0) > 0),
    );
    report.blocks_with_both = blocksWithBoth.length;

    const perBlockStats = new Map();
    for (const b of blockKeys) {
      perBlockStats.set(b, {
        kalshi_unlinked: kalshiUnlinkedByBlock.get(b)?.length ?? 0,
        poly_unlinked: polyUnlinkedByBlock.get(b)?.length ?? 0,
        kalshi_all: kalshiAllByBlock.get(b)?.length ?? 0,
        poly_all: polyAllByBlock.get(b)?.length ?? 0,
        pairs_considered: 0,
        pairs_passed_entity_gate: 0,
        pairs_filtered_generic: 0,
      });
    }

    console.log(
      'pmci:propose:politics blocks (signature or topic) unlinked kalshi=%j poly=%j all kalshi=%j poly=%j blocks_with_both=%d',
      Object.fromEntries([...blockKeys].map((b) => [b, kalshiUnlinkedByBlock.get(b)?.length ?? 0])),
      Object.fromEntries([...blockKeys].map((b) => [b, polyUnlinkedByBlock.get(b)?.length ?? 0])),
      Object.fromEntries([...blockKeys].map((b) => [b, kalshiAllByBlock.get(b)?.length ?? 0])),
      Object.fromEntries([...blockKeys].map((b) => [b, polyAllByBlock.get(b)?.length ?? 0])),
      blocksWithBoth.length,
    );

    const existingPairs = new Set();
    const existingRes = await client.query(
      `SELECT provider_market_id_a, provider_market_id_b, proposed_relationship_type
       FROM pmci.proposed_links WHERE category = $1`,
      [CATEGORY],
    );
    for (const r of existingRes.rows || []) {
      const a = Number(r.provider_market_id_a);
      const b = Number(r.provider_market_id_b);
      existingPairs.add(`${Math.min(a, b)}:${Math.max(a, b)}:${r.proposed_relationship_type}`);
    }

    let nextLinkVersion = null;
    async function getNextLinkVersion() {
      if (nextLinkVersion != null) return nextLinkVersion;
      const vRes = await client.query(`SELECT COALESCE(MAX(version), 0) + 1 AS v FROM pmci.linker_runs`);
      nextLinkVersion = Number(vRes.rows?.[0]?.v ?? 1);
      await client.query(
        `INSERT INTO pmci.linker_runs (version, description) VALUES ($1, $2)`,
        [nextLinkVersion, 'pmci-propose-links-politics auto-accept'],
      );
      return nextLinkVersion;
    }

    async function ensureFamily(label, notes, canonicalEventId) {
      const sel = await client.query(`SELECT id FROM pmci.market_families WHERE label = $1`, [label]);
      if (sel.rows?.[0]) return sel.rows[0].id;
      const ins = await client.query(
        `INSERT INTO pmci.market_families (label, notes, canonical_event_id) VALUES ($1, $2, $3) RETURNING id`,
        [label, notes, canonicalEventId],
      );
      return ins.rows?.[0]?.id;
    }

    async function insertLinks(familyId, idA, idB, providerIdA, providerIdB, relationshipType, confidence, reasons) {
      const version = await getNextLinkVersion();
      const reasonsJson = JSON.stringify(reasons || {});
      await client.query(
        `INSERT INTO pmci.market_links (family_id, provider_id, provider_market_id, relationship_type, status, link_version, confidence, reasons)
         VALUES ($1, $2, $3, $4, 'active', $5, $6, $7::jsonb)`,
        [familyId, providerIdA, idA, relationshipType, version, confidence, reasonsJson],
      );
      await client.query(
        `INSERT INTO pmci.market_links (family_id, provider_id, provider_market_id, relationship_type, status, link_version, confidence, reasons)
         VALUES ($1, $2, $3, $4, 'active', $5, $6, $7::jsonb)`,
        [familyId, providerIdB, idB, relationshipType, version, confidence, reasonsJson],
      );
      return version;
    }

    async function insertSingleLink(familyId, providerId, marketId, relationshipType, confidence, reasons) {
      const version = await getNextLinkVersion();
      const reasonsJson = JSON.stringify(reasons || {});
      await client.query(
        `INSERT INTO pmci.market_links (family_id, provider_id, provider_market_id, relationship_type, status, link_version, confidence, reasons)
         VALUES ($1, $2, $3, $4, 'active', $5, $6, $7::jsonb)`,
        [familyId, providerId, marketId, relationshipType, version, confidence, reasonsJson],
      );
      return version;
    }

    /** Returns { wroteEquiv, wroteProxy } when a proposal was written. */
    async function considerPair(k, p, blockKey, topicStats, isKalshiSource) {
      const idA = Math.min(k.id, p.id);
      const idB = Math.max(k.id, p.id);
      if (existingPairs.has(`${idA}:${idB}:equivalent`)) return { wroteEquiv: false, wroteProxy: false };
      if (existingPairs.has(`${idA}:${idB}:proxy`)) return { wroteEquiv: false, wroteProxy: false };

      topicStats.pairs_considered += 1;
      const entityGatePass = entitySimilarityPass(
        { normalizedEntity: k.normalizedEntity, entityTokens: k.entityTokens, raceTokens: k.raceTokens },
        { normalizedEntity: p.normalizedEntity, entityTokens: p.entityTokens, raceTokens: p.raceTokens },
      );
      if (!entityGatePass) return { wroteEquiv: false, wroteProxy: false };
      topicStats.pairs_passed_entity_gate += 1;
      const proxyEntityGate = !k.genericEntity && !p.genericEntity;
      if (entityGatePass && !proxyEntityGate) {
        topicStats.pairs_filtered_generic = (topicStats.pairs_filtered_generic || 0) + 1;
        report.filtered_generic_entities += 1;
      }

      const titleSim = jaccard(new Set(k.titleTokens), new Set(tokenize(p.title)));
      const slugSim = slugSimilarity(
        tokenize((k.event_ref || k.ref || '').replace(/-/g, ' ')),
        p.slugTokens || tokenize((p.event_ref || p.ref || '').replace(/-/g, ' ')),
      );
      const entityMatch = true;
      const sharedTopics =
        (k.topicTokens?.length && p.topicTokens?.length &&
          k.topicTokens.some((t) => (p.topicTokens || []).includes(t))) || false;

      const kTokens = [...(k.titleTokens || []), ...tokenize((k.event_ref || k.ref || '').replace(/-/g, ' '))];
      const pTokens = [...(p.slugTokens || []), ...tokenize(p.title || '')];
      const kwScore = keywordOverlapScore(kTokens, pTokens);
      const lastNameMatch = !!(k.normalizedEntity && p.normalizedEntity && getLastName(k.normalizedEntity) === getLastName(p.normalizedEntity));
      const entityStrength = lastNameMatch ? 1 : (entityMatch ? 0.7 : 0);
      const topicMatchBonus = 0.1;
      let timeWindowBonus = 0;
      if (k.close_time && p.close_time) {
        const a = new Date(k.close_time).getTime();
        const b = new Date(p.close_time).getTime();
        const days = Math.abs(a - b) / (24 * 60 * 60 * 1000);
        if (days <= 60) timeWindowBonus = 0.05;
      }

      const { equivalent_confidence: rawEquivConf, proxy_confidence } = scorePair(k, p, {
        titleSim,
        slugSim,
        entityMatch,
        sharedTopics,
        keywordOverlapScore: kwScore,
        entityStrength,
        topicMatchBonus,
        timeWindowBonus,
      });

      // Same-block bonus: when both markets share a specific (non-generic) topic signature
      // AND have a last-name match, cross-venue pairs are highly likely to be equivalent.
      // Kalshi tickers yield slugSim≈0 vs Polymarket slugs, so base scoring undervalues them.
      // 0.35 bonus brings same-block+last-name pairs to ≥0.92 → pending proposal queue.
      const sameSpecificSig =
        k.topicSignature && p.topicSignature &&
        k.topicSignature === p.topicSignature &&
        k.topicSignature !== DEFAULT_TOPIC_KEY &&
        k.topicSignature !== 'nominee';
      const sameBlockBonus = sameSpecificSig && lastNameMatch ? 0.35 : 0;
      const equivalent_confidence = Math.min(1, rawEquivConf + sameBlockBonus);

      if (proxyEntityGate) {
        if (!topicStats.topProxyPairs) topicStats.topProxyPairs = [];
        topicStats.topProxyPairs.push({
          proxy_confidence,
          refA: k.ref,
          refB: p.ref,
          titleA: (k.title || '').slice(0, 60),
          titleB: (p.title || '').slice(0, 60),
        });
      }

      const targetLinked = isKalshiSource ? p.isLinked : k.isLinked;
      const targetFamilyId = isKalshiSource ? p.familyId : k.familyId;
      const proposalType = targetLinked ? 'attach_to_family' : 'new_pair';

      const reasons = {
        title_similarity: Math.round(titleSim * 10000) / 10000,
        slug_similarity: Math.round(slugSim * 10000) / 10000,
        entity_match: entityMatch,
        matched_tokens: entityMatch ? [k.entityKey] : [],
        structure_hint: 'binary',
        keyword_overlap_score: Math.round(kwScore * 10000) / 10000,
        entity_strength: entityStrength,
        topic_match_bonus: topicMatchBonus,
        time_window_bonus: timeWindowBonus,
        freshness_a: k.last_seen_at ? new Date(k.last_seen_at).toISOString() : null,
        freshness_b: p.last_seen_at ? new Date(p.last_seen_at).toISOString() : null,
        price_source_a: getPriceSource(k.id),
        price_source_b: getPriceSource(p.id),
        proposal_type: proposalType,
        target_family_id: targetFamilyId ?? undefined,
      };

      const autoAcceptEquiv =
        proposalType === 'attach_to_family' ? equivalent_confidence >= 0.92 : equivalent_confidence >= 0.985;

      if (autoAcceptEquiv && equivalent_confidence >= 0.92) {
        const familyId =
          proposalType === 'attach_to_family' && targetFamilyId ? targetFamilyId : await (async () => {
            const slugFirst = (p.slugTokens && p.slugTokens[0]) || blockKey;
            const entityKey = k.entityKey || p.entityKey || 'unknown';
            const label = `politics::${slugFirst}::::${entityKey}`;
            const notes = `ref_a=${k.ref} ref_b=${p.ref} auto-accepted equivalent`;
            const canonicalEventId = canonicalSlugs.get(p.event_ref || p.ref?.split('#')[0]) ?? null;
            return ensureFamily(label, notes, canonicalEventId);
          })();
        const version =
          proposalType === 'attach_to_family'
            ? await insertSingleLink(
                familyId,
                isKalshiSource ? kalshiId : polyId,
                isKalshiSource ? k.id : p.id,
                'equivalent',
                equivalent_confidence,
                reasons,
              )
            : await insertLinks(
                familyId,
                k.id,
                p.id,
                kalshiId,
                polyId,
                'equivalent',
                equivalent_confidence,
                reasons,
              );
        const insProp = await client.query(
          `INSERT INTO pmci.proposed_links (
            category, provider_market_id_a, provider_market_id_b, proposed_relationship_type,
            confidence, reasons, decision, reviewed_at, reviewer_note, accepted_family_id, accepted_link_version, accepted_relationship_type
          ) VALUES ($1, $2, $3, 'equivalent', $4, $5::jsonb, 'accepted', now(), 'auto-accepted', $6, $7, 'equivalent')
          RETURNING id`,
          [CATEGORY, idA, idB, equivalent_confidence, JSON.stringify(reasons), familyId, version],
        );
        const proposedLinkId = insProp.rows?.[0]?.id;
        if (proposedLinkId) {
          await client.query(
            `INSERT INTO pmci.review_decisions (proposed_link_id, decision, relationship_type, reviewer_note)
             VALUES ($1, 'accepted', 'equivalent', 'auto-accepted')`,
            [proposedLinkId],
          );
        }
        existingPairs.add(`${idA}:${idB}:equivalent`);
        report.autoaccepted_equivalent += 1;
        if (proposalType === 'attach_to_family') report.attach_proposals_written += 1;
        else report.new_pair_proposals_written += 1;
        return { wroteEquiv: true, wroteProxy: false };
      }

      if (equivalent_confidence >= 0.92 && equivalent_confidence < 0.985) {
        if (report.proposals_written_equivalent >= PMCI_MAX_PROPOSALS_EQUIV) {
          report.caps_hit_equiv = true;
          return { wroteEquiv: false, wroteProxy: false };
        }
        try {
          await client.query(
            `INSERT INTO pmci.proposed_links (
              category, provider_market_id_a, provider_market_id_b, proposed_relationship_type, confidence, reasons
            ) VALUES ($1, $2, $3, 'equivalent', $4, $5::jsonb)`,
            [CATEGORY, idA, idB, equivalent_confidence, JSON.stringify(reasons)],
          );
          report.proposals_written_equivalent += 1;
          existingPairs.add(`${idA}:${idB}:equivalent`);
          if (proposalType === 'attach_to_family') report.attach_proposals_written += 1;
          else report.new_pair_proposals_written += 1;
        } catch (err) {
          if (err.code !== '23505') throw err;
        }
        return { wroteEquiv: true, wroteProxy: false };
      }

      if (proxyEntityGate && proxy_confidence >= 0.88 && proxy_confidence < 0.97 && (entityMatch || sharedTopics)) {
        if (report.proposals_written_proxy >= PMCI_MAX_PROPOSALS_PROXY) {
          report.caps_hit_proxy = true;
          return { wroteEquiv: false, wroteProxy: false };
        }
        try {
          await client.query(
            `INSERT INTO pmci.proposed_links (
              category, provider_market_id_a, provider_market_id_b, proposed_relationship_type, confidence, reasons
            ) VALUES ($1, $2, $3, 'proxy', $4, $5::jsonb)`,
            [
              CATEGORY,
              idA,
              idB,
              proxy_confidence,
              JSON.stringify({ ...reasons, proxy_reason: 'topic_or_entity_match' }),
            ],
          );
          report.proposals_written_proxy += 1;
          existingPairs.add(`${idA}:${idB}:proxy`);
          if (proposalType === 'attach_to_family') report.attach_proposals_written += 1;
          else report.new_pair_proposals_written += 1;
        } catch (err) {
          if (err.code !== '23505') throw err;
        }
        return { wroteEquiv: false, wroteProxy: true };
      }
      report.skipped_low_confidence += 1;
      return { wroteEquiv: false, wroteProxy: false };
    }

    for (const block of blocksWithBoth) {
      const kUnlinked = kalshiUnlinkedByBlock.get(block) || [];
      const pAll = polyAllByBlock.get(block) || [];
      const pUnlinked = polyUnlinkedByBlock.get(block) || [];
      const kAll = kalshiAllByBlock.get(block) || [];
      const topicStats = perBlockStats.get(block);
      let perBlockEquiv = 0;
      let perBlockProxy = 0;

      for (const k of kUnlinked) {
        if (report.proposals_written_equivalent >= PMCI_MAX_PROPOSALS_EQUIV) {
          report.caps_hit_equiv = true;
          break;
        }
        if (report.proposals_written_proxy >= PMCI_MAX_PROPOSALS_PROXY) {
          report.caps_hit_proxy = true;
          break;
        }
        if (perBlockEquiv + perBlockProxy >= PMCI_MAX_PER_BLOCK) break;
        for (const p of pAll) {
          const r = await considerPair(k, p, block, topicStats, true);
          if (r?.wroteEquiv) perBlockEquiv += 1;
          if (r?.wroteProxy) perBlockProxy += 1;
        }
      }

      for (const p of pUnlinked) {
        if (report.proposals_written_equivalent >= PMCI_MAX_PROPOSALS_EQUIV) {
          report.caps_hit_equiv = true;
          break;
        }
        if (report.proposals_written_proxy >= PMCI_MAX_PROPOSALS_PROXY) {
          report.caps_hit_proxy = true;
          break;
        }
        if (perBlockEquiv + perBlockProxy >= PMCI_MAX_PER_BLOCK) break;
        for (const k of kAll) {
          const r = await considerPair(k, p, block, topicStats, false);
          if (r?.wroteEquiv) perBlockEquiv += 1;
          if (r?.wroteProxy) perBlockProxy += 1;
        }
      }
    }

    const blockStatsWithPairs = [...perBlockStats.entries()].filter(([, s]) => s.pairs_considered > 0);
    if (blockStatsWithPairs.length > 0) {
      console.log(
        'pmci:propose:politics per_signature pairs_considered passed_entity_gate filtered_generic kalshi_unlinked poly_unlinked:',
      );
      for (const [block, s] of blockStatsWithPairs) {
        console.log(
          '  %s: pairs_considered=%d pairs_passed_entity_gate=%d pairs_filtered_generic=%d kalshi_unlinked=%d poly_unlinked=%d',
          block,
          s.pairs_considered,
          s.pairs_passed_entity_gate,
          s.pairs_filtered_generic ?? 0,
          s.kalshi_unlinked ?? 0,
          s.poly_unlinked ?? 0,
        );
        const top = (s.topProxyPairs || [])
          .sort((a, b) => (b.proxy_confidence || 0) - (a.proxy_confidence || 0))
          .slice(0, 5);
        if (top.length > 0) {
          console.log('  %s top proxyConf (non-generic only, even if below threshold):', block);
          for (const x of top) {
            console.log(
              '    proxyConf=%s refA=%s refB=%s | %s | %s',
              x.proxy_confidence,
              (x.refA || '').slice(0, 40),
              (x.refB || '').slice(0, 50),
              (x.titleA || '').slice(0, 45),
              (x.titleB || '').slice(0, 45),
            );
          }
        }
      }
    }
    if (report.filtered_generic_entities > 0) {
      console.log('pmci:propose:politics filtered_generic_entities=%d (proxy entity gate requires non-generic on both sides)', report.filtered_generic_entities);
    }

    console.log(
      'pmci:propose:politics attach_proposals_written=%d new_pair_proposals_written=%d',
      report.attach_proposals_written,
      report.new_pair_proposals_written,
    );

    if (report.caps_hit_equiv) console.log('pmci:propose:politics caps hit: PMCI_MAX_PROPOSALS_EQUIV');
    if (report.caps_hit_proxy) console.log('pmci:propose:politics caps hit: PMCI_MAX_PROPOSALS_PROXY');

    console.log(
      'pmci:propose:politics pool kalshi_unlinked_count=%d polymarket_unlinked_count=%d (universe_filtered kalshi=%d poly=%d) blocks_with_both=%d',
      report.kalshi_unlinked_count,
      report.polymarket_unlinked_count,
      report.kalshi_universe_filtered,
      report.polymarket_universe_filtered,
      report.blocks_with_both,
    );
    console.log(
      'pmci:propose:politics done proposals_written_equivalent=%d proposals_written_proxy=%d attach=%d new_pair=%d autoaccepted_equivalent=%d skipped_already_linked=%d skipped_low_confidence=%d',
      report.proposals_written_equivalent,
      report.proposals_written_proxy,
      report.attach_proposals_written,
      report.new_pair_proposals_written,
      report.autoaccepted_equivalent,
      report.skipped_already_linked,
      report.skipped_low_confidence,
    );
    // Validation targets: expand Kalshi series so unlinked >= 100; topic blocking should yield some proxy proposals at min_confidence 0.88
    const kalshiTargetOk = report.kalshi_unlinked_count >= 100;
    const proxyTargetOk = report.proposals_written_proxy > 0;
    console.log(
      'pmci:propose:politics validation kalshi_unlinked_count=%d (target>=100: %s) proposals_written_proxy=%d (target>0 min_confidence>=0.88: %s)',
      report.kalshi_unlinked_count,
      kalshiTargetOk ? 'ok' : 'below_target',
      report.proposals_written_proxy,
      proxyTargetOk ? 'ok' : 'none',
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('pmci:propose:politics FAIL:', err.message);
  process.exit(1);
});
