#!/usr/bin/env node
/**
 * Sport-bucketed proposer: matches Kalshi ↔ Polymarket sports markets one sport
 * at a time using title-based team extraction, avoiding the OOM that occurs when
 * loading all sports as one cross-product.
 *
 * Bypasses the broken home_team/away_team DB columns by parsing team names
 * directly from market titles with "vs" splitting.
 */
import pg from 'pg';
import { loadEnv } from '../../src/platform/env.mjs';
import { tokenize, parseVectorColumn, cosineSimilarity } from '../../lib/matching/scoring.mjs';
import { sportsDateDeltaDays, classifyMarketTypeBucket } from '../../lib/matching/sports-helpers.mjs';

loadEnv();
const { Client } = pg;

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const verbose = argv.includes('--verbose');
const limitIdx = argv.indexOf('--limit');
const limitPerSport = limitIdx >= 0 ? Number(argv[limitIdx + 1] || 500) : 500;
const capIdx = argv.indexOf('--market-cap');
const marketCap = capIdx >= 0 ? Number(argv[capIdx + 1] || 2000) : 2000;

const MULTI_WORD_CITIES = [
  'new york', 'los angeles', 'san diego', 'san francisco', 'kansas city',
  'st louis', 'st. louis', 'tampa bay', 'golden state', 'oklahoma city',
  'green bay', 'san antonio', 'salt lake', 'las vegas', 'real madrid',
  'atletico madrid', 'manchester united', 'manchester city', 'west ham',
  'crystal palace', 'aston villa', 'newcastle united', 'nottingham forest',
  'wolverhampton wanderers', 'brighton hove', 'borussia dortmund',
  'borussia monchengladbach', 'bayer leverkusen', 'rb leipzig',
  'paris saint', 'inter milan', 'ac milan', 'red bull',
];

const TEAM_ALIASES = new Map([
  // MLB
  ["a's", 'athletics'], ['a s', 'athletics'], ['as', 'athletics'],
  ['chicago ws', 'chicago white sox'], ['chicago c', 'chicago cubs'],
  ['chicago w', 'chicago white sox'],
  ['la d', 'los angeles dodgers'], ['la a', 'los angeles angels'],
  ['los angeles d', 'los angeles dodgers'], ['los angeles a', 'los angeles angels'],
  ['new york m', 'new york mets'], ['new york y', 'new york yankees'],
  ['ny m', 'new york mets'], ['ny y', 'new york yankees'],
  // NHL — city → nickname mapping (Kalshi uses cities, Polymarket uses nicknames)
  ['washington', 'capitals'], ['capitals', 'capitals'],
  ['new jersey', 'devils'], ['devils', 'devils'],
  ['columbus', 'blue jackets'], ['blue jackets', 'blue jackets'],
  ['colorado', 'avalanche'], ['avalanche', 'avalanche'],
  ['edmonton', 'oilers'], ['oilers', 'oilers'],
  ['los angeles', 'kings'], ['kings', 'kings'],
  ['seattle', 'kraken'], ['kraken', 'kraken'],
  ['winnipeg', 'jets'], ['jets', 'jets'],
  ['vegas', 'golden knights'], ['golden knights', 'golden knights'],
  ['carolina', 'hurricanes'], ['hurricanes', 'hurricanes'],
  ['ny islanders', 'islanders'], ['islanders', 'islanders'],
  ['montreal', 'canadiens'], ['canadiens', 'canadiens'],
  ['philadelphia', 'flyers'], ['flyers', 'flyers'],
  ['pittsburgh', 'penguins'], ['penguins', 'penguins'],
  ['tampa bay', 'lightning'], ['lightning', 'lightning'],
  ['new york r', 'rangers'], ['rangers', 'rangers'],
  ['boston', 'bruins'], ['bruins', 'bruins'],
  ['toronto', 'maple leafs'], ['maple leafs', 'maple leafs'],
  ['florida', 'panthers'], ['panthers', 'panthers'],
  ['ottawa', 'senators'], ['senators', 'senators'],
  ['detroit', 'red wings'], ['red wings', 'red wings'],
  ['buffalo', 'sabres'], ['sabres', 'sabres'],
  ['minnesota', 'wild'], ['wild', 'wild'],
  ['st louis', 'blues'], ['blues', 'blues'],
  ['dallas', 'stars'], ['stars', 'stars'],
  ['nashville', 'predators'], ['predators', 'predators'],
  ['chicago', 'blackhawks'], ['blackhawks', 'blackhawks'],
  ['calgary', 'flames'], ['flames', 'flames'],
  ['vancouver', 'canucks'], ['canucks', 'canucks'],
  ['san jose', 'sharks'], ['sharks', 'sharks'],
  ['anaheim', 'ducks'], ['ducks', 'ducks'],
  ['utah', 'utah hockey club'],
  // Soccer aliases
  ['incheon utd', 'incheon united'], ['daejeon citizen', 'daejeon hana citizen'],
  ['man city', 'manchester city'], ['man utd', 'manchester united'],
  ['man united', 'manchester united'],
]);

function cleanTeamPart(raw) {
  return raw
    // Strip colon-separated market type suffixes (Polymarket format)
    .replace(/:\s*(both\s+teams?\s+to\s+score|btts|o\/u\s+[\d.]+|over\s*[\d.]*|under\s*[\d.]*|spread.*|totals?|handicap|moneyline|winner|1h\s+winner|match\s+winner|game\s+\d+\s+winner|bo\d).*$/i, '')
    // Strip trailing market types (Kalshi format)
    .replace(/\s*(winner|first\s+\d+\s+innings?\s+winner|first\s+inning\s+run|first\s+\d+\s+innings\s+runs|total\s+.*|spread.*|match\s+winner|1st\s+half\s+winner|halftime\s+winner|end\s+in\s+a\s+draw)\??$/i, '')
    // Strip league prefixes
    .replace(/^(KBO|NPB|LPB|Serie\s*A|La\s*Liga|EPL|MLS|UCL|UEL|UECL|WNBA|NWSL|LoL|CS2)\s*:\s*/i, '')
    .replace(/^Will\s+/i, '')
    .replace(/\s+FC$/i, '')
    .replace(/\s+$/, '')
    .trim();
}

function extractTeamsFromTitle(title) {
  if (!title) return null;
  const vsMatch = title.match(/^(.+?)\s+vs\.?\s+(.+)$/i);
  if (!vsMatch) return null;
  const a = cleanTeamPart(vsMatch[1].trim());
  const b = cleanTeamPart(vsMatch[2].trim());
  if (!a || !b || a.length < 2 || b.length < 2) return null;
  return [a, b];
}

function normalizeTeam(teamName) {
  const raw = teamName.toLowerCase().trim();
  if (TEAM_ALIASES.has(raw)) return TEAM_ALIASES.get(raw);

  const lower = raw.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (TEAM_ALIASES.has(lower)) return TEAM_ALIASES.get(lower);

  const parts = lower.split(' ');
  for (let n = Math.min(parts.length, 3); n >= 2; n--) {
    const prefix = parts.slice(0, n).join(' ');
    if (TEAM_ALIASES.has(prefix)) return TEAM_ALIASES.get(prefix);
  }
  // Single-word alias lookup (catches nickname-only like "Capitals", "Sharks")
  if (parts.length === 1 && TEAM_ALIASES.has(parts[0])) return TEAM_ALIASES.get(parts[0]);

  return lower;
}

function extractCityPrefix(normalized) {
  for (const city of MULTI_WORD_CITIES) {
    if (normalized.startsWith(city)) return city;
  }
  return normalized.split(' ')[0] || normalized;
}

function teamTokens(teamName) {
  return tokenize(teamName.toLowerCase().replace(/[^a-z0-9\s]/g, ' '));
}

function teamsMatchScore(teamsA, teamsB) {
  if (!teamsA || !teamsB || teamsA.length !== 2 || teamsB.length !== 2) return 0;

  const normedA = teamsA.map(normalizeTeam);
  const normedB = teamsB.map(normalizeTeam);

  // Exact full-name match on both teams
  if (
    (normedA[0] === normedB[0] && normedA[1] === normedB[1]) ||
    (normedA[0] === normedB[1] && normedA[1] === normedB[0])
  ) return 1.0;

  function teamOverlap(nameA, nameB) {
    if (nameA === nameB) return 1.0;
    const cityA = extractCityPrefix(nameA);
    const cityB = extractCityPrefix(nameB);
    if (cityA !== cityB) return 0;
    // Same city — check if both have team suffixes that conflict
    const suffA = nameA.slice(cityA.length).trim();
    const suffB = nameB.slice(cityB.length).trim();
    if (suffA && suffB) {
      // Both have team names beyond city — must overlap
      const tokA = suffA.split(' ').filter(t => t.length > 1);
      const tokB = suffB.split(' ').filter(t => t.length > 1);
      const shared = tokA.filter(t => tokB.includes(t));
      return shared.length > 0 ? 0.9 : 0;
    }
    // One is city-only, other has full name — city match is good enough
    // (only fails for same-city teams like NYY/NYM, but rare)
    return 0.8;
  }

  let bestScore = 0;
  for (const perm of [[0, 1], [1, 0]]) {
    const s0 = teamOverlap(normedA[0], normedB[perm[0]]);
    const s1 = teamOverlap(normedA[1], normedB[perm[1]]);
    if (s0 > 0 && s1 > 0) {
      bestScore = Math.max(bestScore, (s0 + s1) / 2);
    }
  }

  return bestScore;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    const provRes = await client.query(
      `SELECT id, code FROM pmci.providers WHERE code IN ('kalshi','polymarket')`,
    );
    const byCode = new Map(provRes.rows.map(r => [r.code, r.id]));
    const kalshiId = Number(byCode.get('kalshi'));
    const polyId = Number(byCode.get('polymarket'));

    // Sport code aliasing: group equivalent sport codes that differ between providers
    const SPORT_GROUPS = [
      ['soccer', 'j1-100', 'j2-100', 'ukr1', 'itsb'],
      ['nhl', 'wwoh'],
      ['nba', 'basketball', 'bkfibaqeu', 'bkjpn', 'euroleague', 'bkaba', 'bkbbl', 'bkbsl', 'bkgr1', 'bkvtb'],
      ['cricket', 'cricipl', 'cricpsl'],
    ];

    function getSportFamily(sport) {
      for (const group of SPORT_GROUPS) {
        if (group.includes(sport)) return group;
      }
      return [sport];
    }

    const { rows: sportRows } = await client.query(`
      SELECT DISTINCT pm.sport
      FROM pmci.provider_markets pm
      WHERE pm.category = 'sports'
        AND COALESCE(pm.status, '') IN ('active', 'open')
        AND pm.sport IS NOT NULL AND pm.sport <> 'unknown'
        AND (pm.close_time IS NULL OR pm.close_time > NOW())
    `);

    // Build sport families that have markets on both providers
    const allSportCodes = sportRows.map(r => r.sport);
    const seenFamilies = new Set();
    const sportFamilies = [];
    for (const code of allSportCodes) {
      const family = getSportFamily(code);
      const key = family.sort().join(',');
      if (seenFamilies.has(key)) continue;
      seenFamilies.add(key);
      sportFamilies.push(family);
    }

    // Filter to families that have markets on >=2 providers
    const validFamilies = [];
    for (const family of sportFamilies) {
      const { rows: provCheck } = await client.query(`
        SELECT COUNT(DISTINCT p.code) as provider_count
        FROM pmci.provider_markets pm
        JOIN pmci.providers p ON p.id = pm.provider_id
        WHERE pm.category = 'sports'
          AND COALESCE(pm.status, '') IN ('active', 'open')
          AND pm.sport = ANY($1::text[])
          AND (pm.close_time IS NULL OR pm.close_time > NOW())
      `, [family]);
      if (Number(provCheck[0]?.provider_count) >= 2) validFamilies.push(family);
    }

    console.log(`[bucketed-proposer] found ${validFamilies.length} sport families on both providers:`);
    for (const f of validFamilies) console.log(`  ${f.join(', ')}`);

    const existingRes = await client.query(`
      SELECT provider_market_id_a, provider_market_id_b
      FROM pmci.proposed_links WHERE category = 'sports'
    `);
    const existingPairs = new Set();
    for (const r of existingRes.rows) {
      const a = Number(r.provider_market_id_a);
      const b = Number(r.provider_market_id_b);
      existingPairs.add(`${Math.min(a, b)}:${Math.max(a, b)}`);
    }

    let totalConsidered = 0;
    let totalInserted = 0;
    let totalRejected = 0;
    let totalSkippedExisting = 0;

    for (const family of validFamilies) {
      const familyLabel = family.join('+');
      console.log(`\n========== [sport=${familyLabel}] ==========`);

      const { rows: kalshiRows } = await client.query(`
        SELECT pm.id, pm.provider_market_ref, pm.title, pm.sport,
               pm.game_date, pm.close_time, pm.title_embedding
        FROM pmci.provider_markets pm
        WHERE pm.provider_id = $1 AND pm.category = 'sports' AND pm.sport = ANY($2::text[])
          AND COALESCE(pm.status, '') IN ('active', 'open')
          AND (pm.close_time IS NULL OR pm.close_time > NOW())
        ORDER BY pm.last_seen_at DESC NULLS LAST
        LIMIT $3
      `, [kalshiId, family, marketCap]);

      const { rows: polyRows } = await client.query(`
        SELECT pm.id, pm.provider_market_ref, pm.title, pm.sport,
               pm.game_date, pm.close_time, pm.title_embedding
        FROM pmci.provider_markets pm
        WHERE pm.provider_id = $1 AND pm.category = 'sports' AND pm.sport = ANY($2::text[])
          AND COALESCE(pm.status, '') IN ('active', 'open')
          AND (pm.close_time IS NULL OR pm.close_time > NOW())
        ORDER BY pm.last_seen_at DESC NULLS LAST
        LIMIT $3
      `, [polyId, family, marketCap]);

      console.log(`[sport=${familyLabel}] kalshi=${kalshiRows.length} polymarket=${polyRows.length}`);

      if (kalshiRows.length === 0 || polyRows.length === 0) {
        console.log(`[sport=${familyLabel}] skipping — one side has 0 markets`);
        continue;
      }

      const sport = family[0];

      const polyByDate = new Map();
      for (const p of polyRows) {
        const d = p.game_date instanceof Date
          ? p.game_date.toISOString().slice(0, 10)
          : String(p.game_date || '').slice(0, 10);
        if (!d || d === 'null') {
          if (!polyByDate.has('_none')) polyByDate.set('_none', []);
          polyByDate.get('_none').push(p);
          continue;
        }
        if (!polyByDate.has(d)) polyByDate.set(d, []);
        polyByDate.get(d).push(p);
      }

      let sportInserted = 0;
      let sportConsidered = 0;
      let sportRejected = 0;
      let sportSkippedExisting = 0;

      for (const k of kalshiRows) {
        if (sportInserted >= limitPerSport) break;

        const kTeams = extractTeamsFromTitle(k.title);
        if (!kTeams) continue;

        const kDate = k.game_date instanceof Date
          ? k.game_date.toISOString().slice(0, 10)
          : String(k.game_date || '').slice(0, 10);

        const kBucket = classifyMarketTypeBucket(k.title);
        const kEmb = parseVectorColumn(k.title_embedding);

        const candidatePoly = [];
        const datesToCheck = [];
        if (kDate && kDate !== 'null') {
          const d = new Date(kDate + 'T00:00:00Z');
          for (let offset = -1; offset <= 1; offset++) {
            const nd = new Date(d.getTime() + offset * 86400000);
            datesToCheck.push(nd.toISOString().slice(0, 10));
          }
        }
        for (const checkDate of datesToCheck) {
          if (polyByDate.has(checkDate)) candidatePoly.push(...polyByDate.get(checkDate));
        }
        if (!kDate || kDate === 'null') {
          if (polyByDate.has('_none')) candidatePoly.push(...polyByDate.get('_none'));
        }

        for (const p of candidatePoly) {
          if (sportInserted >= limitPerSport) break;
          sportConsidered++;

          const idA = Math.min(Number(k.id), Number(p.id));
          const idB = Math.max(Number(k.id), Number(p.id));
          const pairKey = `${idA}:${idB}`;
          if (existingPairs.has(pairKey)) {
            sportSkippedExisting++;
            continue;
          }

          const pBucket = classifyMarketTypeBucket(p.title);
          if (kBucket && pBucket && kBucket !== pBucket) {
            sportRejected++;
            continue;
          }

          const pTeams = extractTeamsFromTitle(p.title);
          if (!pTeams) { sportRejected++; continue; }

          const matchScore = teamsMatchScore(kTeams, pTeams);
          if (matchScore === 0) { sportRejected++; continue; }

          let embSim = null;
          const pEmb = parseVectorColumn(p.title_embedding);
          if (kEmb && pEmb) embSim = cosineSimilarity(kEmb, pEmb);

          let confidence;
          if (matchScore >= 0.95) {
            confidence = 0.96;
          } else if (matchScore >= 0.7) {
            confidence = 0.88 + matchScore * 0.05;
          } else {
            confidence = 0.78 + matchScore * 0.1;
          }
          // Embedding boost/penalty
          if (embSim != null && embSim >= 0.6) confidence = Math.min(0.98, confidence + 0.02);
          if (embSim != null && embSim < 0.3) confidence *= 0.85;
          confidence = Math.round(confidence * 10000) / 10000;

          if (confidence < 0.78) {
            sportRejected++;
            continue;
          }

          const pDate = p.game_date instanceof Date
            ? p.game_date.toISOString().slice(0, 10)
            : String(p.game_date || '').slice(0, 10);

          const reasons = {
            sport,
            teams_a: kTeams,
            teams_b: pTeams,
            team_match_score: Math.round(matchScore * 10000) / 10000,
            embedding_sim: embSim != null ? Math.round(embSim * 10000) / 10000 : null,
            game_date_a: kDate || null,
            game_date_b: pDate || null,
            market_bucket_a: kBucket,
            market_bucket_b: pBucket,
            source: 'sports_bucketed_proposer_v2',
          };
          const features = {
            team_match_score: Math.round(matchScore * 10000) / 10000,
            embedding_sim: embSim != null ? Math.round(embSim * 10000) / 10000 : null,
            confidence_raw: Math.round(confidence * 10000) / 10000,
          };

          verbose && console.log(
            `[match] conf=${confidence.toFixed(3)} teams=${kTeams.join('|')} ↔ ${pTeams.join('|')} embSim=${embSim?.toFixed(3)}`,
          );

          if (!dryRun) {
            try {
              await client.query(
                `INSERT INTO pmci.proposed_links (
                  category, provider_market_id_a, provider_market_id_b,
                  proposed_relationship_type, confidence, reasons, features
                ) VALUES ('sports', $1, $2, 'equivalent', $3, $4::jsonb, $5::jsonb)
                ON CONFLICT DO NOTHING`,
                [idA, idB, confidence, JSON.stringify(reasons), JSON.stringify(features)],
              );
            } catch (err) {
              if (err.code !== '23505') throw err;
            }
          }
          existingPairs.add(pairKey);
          sportInserted++;
        }
      }

      totalConsidered += sportConsidered;
      totalInserted += sportInserted;
      totalRejected += sportRejected;
      totalSkippedExisting += sportSkippedExisting;
      console.log(
        `[sport=${sport}] considered=${sportConsidered} inserted=${sportInserted} rejected=${sportRejected} skipped_existing=${sportSkippedExisting}`,
      );
    }

    console.log(`\n========== TOTALS ==========`);
    console.log(
      `[bucketed-proposer] sport_families=${validFamilies.length} total_considered=${totalConsidered} total_inserted=${totalInserted} total_rejected=${totalRejected} total_skipped_existing=${totalSkippedExisting}`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[bucketed-proposer] FAIL:', err.message);
  process.exit(1);
});
