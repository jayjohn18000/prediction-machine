#!/usr/bin/env node
import pg from 'pg';
import { loadEnv } from '../../src/platform/env.mjs';
import { sportsEntityFromMarket, sportsDateDeltaDays, isSportsPairSemanticallyValid, looksLikeMatchupMarket } from '../../lib/matching/sports-helpers.mjs';

loadEnv();
const { Client } = pg;

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const sportIdx = argv.indexOf('--sport');
  const sportFilter = sportIdx >= 0 ? String(argv[sportIdx + 1] || '').toLowerCase().trim() : null;
  const limitIdx = argv.indexOf('--limit');
  const limit = limitIdx >= 0 ? Math.max(1, Number(argv[limitIdx + 1] || 0)) : 250;

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const providers = await client.query(`select id, code from pmci.providers where code in ('kalshi','polymarket') order by code`);
    const byCode = new Map(providers.rows.map((r) => [r.code, r.id]));
    const kalshiId = Number(byCode.get('kalshi'));
    const polyId = Number(byCode.get('polymarket'));

    const markets = await client.query(`
      select id, provider_id, provider_market_ref, event_ref, title, sport, game_date, home_team, away_team, status, close_time
      from pmci.provider_markets
      where category = 'sports'
        and coalesce(status,'') in ('active','open')
        and sport is not null
        and sport <> 'unknown'
        and game_date is not null
        and home_team is not null
        and away_team is not null
        and ($1::text is null or lower(sport) = $1)
      order by game_date desc, id desc
    `, [sportFilter]);

    const kalshi = markets.rows.filter((r) => r.provider_id === kalshiId);
    const poly = markets.rows.filter((r) => r.provider_id === polyId);

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

    for (const k of kalshi) {
      const ks = sportsEntityFromMarket(k);
      if (!ks.isMatchup || ks.matchupKey === 'unknown') continue;
      for (const p of poly) {
        if (pairBudget >= limit) break;
        const ps = sportsEntityFromMarket(p);
        if (!ps.isMatchup || ps.matchupKey === 'unknown') continue;
        if (ks.sport !== ps.sport) continue;
        const dateDelta = sportsDateDeltaDays(ks.gameDate, ps.gameDate);
        considered += 1;

        const semantic = isSportsPairSemanticallyValid(k, p);
        if (!semantic.ok) {
          rejected += 1;
          continue;
        }

        const pairKey = `${Math.min(k.id, p.id)}:${Math.max(k.id, p.id)}:equivalent`;
        if (existingPairs.has(pairKey)) continue;

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
          confidence_raw: ks.matchupKey === ps.matchupKey ? 0.96 : 0.0,
        };

        if (!dryRun) {
          await client.query(
            `insert into pmci.proposed_links (
              category, provider_market_id_a, provider_market_id_b, proposed_relationship_type, confidence, reasons, features
            ) values ('sports', $1, $2, 'equivalent', $3, $4::jsonb, $5::jsonb)
             on conflict do nothing`,
            [Math.min(k.id, p.id), Math.max(k.id, p.id), 0.96, JSON.stringify(reasons), JSON.stringify(features)],
          );
        }
        existingPairs.add(pairKey);
        inserted += 1;
        pairBudget += 1;
      }
      if (pairBudget >= limit) break;
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
