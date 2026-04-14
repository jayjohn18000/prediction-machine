#!/usr/bin/env node
import pg from 'pg';
import { loadEnv } from '../../src/platform/env.mjs';
import { sportsEntityFromMarket, sportsDateDeltaDays, isSportsPairSemanticallyValid, looksLikeMatchupMarket } from '../../lib/matching/sports-helpers.mjs';
import { sportsMarketTypePairAllowed } from '../../lib/matching/compatibility.mjs';

loadEnv();
const { Client } = pg;

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const verbose = argv.includes('--verbose');
  const sportIdx = argv.indexOf('--sport');
  const sportFilter = sportIdx >= 0 ? String(argv[sportIdx + 1] || '').toLowerCase().trim() : null;
  const limitIdx = argv.indexOf('--limit');
  const limit = limitIdx >= 0 ? Math.max(1, Number(argv[limitIdx + 1] || 0)) : 250;
  const capIdx = argv.indexOf('--market-cap');
  const marketCapPerSide = capIdx >= 0
    ? Math.max(50, Number(argv[capIdx + 1] || 0))
    : Math.max(50, Number(process.env.PMCI_PROPOSE_SPORTS_MARKETS_PER_SIDE || 1500));

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const providers = await client.query(`select id, code from pmci.providers where code in ('kalshi','polymarket') order by code`);
    const byCode = new Map(providers.rows.map((r) => [r.code, r.id]));
    const kalshiId = Number(byCode.get('kalshi'));
    const polyId = Number(byCode.get('polymarket'));

    const baseWhere = `
      category = 'sports'
        and coalesce(status,'') in ('active','open')
        and sport is not null
        and sport <> 'unknown'
        and game_date is not null
        and home_team is not null
        and away_team is not null
        and ($1::text is null or lower(sport) = $1)`;

    const { rows: kalshiRows } = await client.query(
      `
      select id, provider_id, provider_market_ref, event_ref, title, sport, game_date, home_team, away_team, status, close_time
      from pmci.provider_markets
      where provider_id = $2 and ${baseWhere}
      order by game_date desc, id desc
      limit $3
    `,
      [sportFilter, kalshiId, marketCapPerSide],
    );
    const { rows: polyRows } = await client.query(
      `
      select id, provider_id, provider_market_ref, event_ref, title, sport, game_date, home_team, away_team, status, close_time
      from pmci.provider_markets
      where provider_id = $2 and ${baseWhere}
      order by game_date desc, id desc
      limit $3
    `,
      [sportFilter, polyId, marketCapPerSide],
    );

    const kalshi = kalshiRows;
    const poly = polyRows;
    console.log(
      `[pmci:propose:sports] candidate markets: kalshi=${kalshi.length} polymarket=${poly.length} (cap ${marketCapPerSide}/side)`,
    );

    const existing = await client.query(`
      select provider_market_id_a, provider_market_id_b, proposed_relationship_type
      from pmci.proposed_links
      where category = 'sports'
    `);
    const existingPairs = new Set(existing.rows.map((r) => `${Math.min(r.provider_market_id_a, r.provider_market_id_b)}:${Math.max(r.provider_market_id_a, r.provider_market_id_b)}:${r.proposed_relationship_type}`));

    let inserted = 0;
    let considered = 0;
    let rejected = 0;
    let pairBudget = 0;

    // A2: track proposals emitted per matchup_key across the full run
    const proposalsPerMatchup = new Map();

    for (const k of kalshi) {
      if (pairBudget >= limit) break;
      const ks = sportsEntityFromMarket(k);
      if (!ks.isMatchup || ks.matchupKey === 'unknown') continue;

      // Collect valid candidates for this Kalshi market before inserting (needed for A2 sort)
      const candidates = [];

      for (const p of poly) {
        const ps = sportsEntityFromMarket(p);
        if (!ps.isMatchup || ps.matchupKey === 'unknown') continue;
        if (ks.sport !== ps.sport) continue;

        // A1: compute delta with Date-object-safe helper; gate on null or >7d
        const dateDelta = sportsDateDeltaDays(ks.gameDate, ps.gameDate);
        considered += 1;

        if (dateDelta === null) {
          verbose && console.log(`[skip] date_null ${ks.matchupKey}`);
          rejected += 1;
          continue;
        }
        if (dateDelta > 7) {
          verbose && console.log(`[skip] date_gap:${dateDelta}d ${ks.matchupKey}`);
          rejected += 1;
          continue;
        }

        const compat = sportsMarketTypePairAllowed(k.title, p.title);
        if (!compat.ok) {
          const skipReason = compat.reason;
          verbose && console.log(`[skip] ${skipReason} ${ks.matchupKey}`);
          const skipReasons = {
            skip_reason: skipReason,
            sport: ks.sport,
            matchup_key: ks.matchupKey,
            source: 'sports_proposer_v1',
          };
          if (!dryRun) {
            await client.query(
              `insert into pmci.proposed_links (
                category, provider_market_id_a, provider_market_id_b, proposed_relationship_type, confidence, reasons, features, decision
              ) values ('sports', $1, $2, 'equivalent', $3, $4::jsonb, $5::jsonb, 'rejected')
               on conflict do nothing`,
              [Math.min(k.id, p.id), Math.max(k.id, p.id), 0.0, JSON.stringify(skipReasons), JSON.stringify({})],
            );
          }
          rejected += 1;
          continue;
        }

        const semantic = isSportsPairSemanticallyValid(k, p);
        if (!semantic.ok) {
          rejected += 1;
          continue;
        }

        const pairKey = `${Math.min(k.id, p.id)}:${Math.max(k.id, p.id)}:equivalent`;
        if (existingPairs.has(pairKey)) continue;

        const confidence = ks.matchupKey === ps.matchupKey ? 0.96 : 0.0;
        candidates.push({ p, ps, pairKey, dateDelta, confidence });
      }

      // A2: sort by confidence desc, then dateDelta asc (closer date = better tiebreaker)
      candidates.sort((a, b) => b.confidence - a.confidence || a.dateDelta - b.dateDelta);

      for (const { p, ps, pairKey, dateDelta, confidence } of candidates) {
        if (pairBudget >= limit) break;

        // A2: enforce global cap of 3 pending proposals per matchup_key
        const matchupCount = proposalsPerMatchup.get(ks.matchupKey) || 0;
        if (matchupCount >= 3) {
          verbose && console.log(`[skip] fan_out_suppressed ${ks.matchupKey}`);
          rejected += 1;
          continue;
        }

        const reasons = {
          sport: ks.sport,
          matchup_key: ks.matchupKey,
          game_date_a: ks.gameDate,
          game_date_b: ps.gameDate,
          date_delta_days: dateDelta,
          source: 'sports_proposer_v1'
        };
        const features = {
          sport_match: ks.sport === ps.sport ? 1 : 0,
          matchup_match: ks.matchupKey === ps.matchupKey ? 1 : 0,
          date_delta_days: dateDelta,
          confidence_raw: confidence,
        };

        if (!dryRun) {
          await client.query(
            `insert into pmci.proposed_links (
              category, provider_market_id_a, provider_market_id_b, proposed_relationship_type, confidence, reasons, features
            ) values ('sports', $1, $2, 'equivalent', $3, $4::jsonb, $5::jsonb)
             on conflict do nothing`,
            [Math.min(k.id, p.id), Math.max(k.id, p.id), confidence, JSON.stringify(reasons), JSON.stringify(features)],
          );
        }
        existingPairs.add(pairKey);
        proposalsPerMatchup.set(ks.matchupKey, matchupCount + 1);
        inserted += 1;
        pairBudget += 1;
      }
    }

    console.log(`pmci:propose:sports sport=${sportFilter || 'all'} considered=${considered} inserted=${inserted} rejected=${rejected} limit=${limit}${dryRun ? ' dry-run=true' : ''}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('pmci:propose:sports FAIL:', err.message);
  process.exit(1);
});
