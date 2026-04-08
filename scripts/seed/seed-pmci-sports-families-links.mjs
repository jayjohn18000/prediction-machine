#!/usr/bin/env node
import pg from 'pg';
import { loadEnv } from '../../src/platform/env.mjs';
import { sportsEntityFromMarket, looksLikeMatchupMarket } from '../../lib/matching/sports-helpers.mjs';

loadEnv();
const { Client } = pg;

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const argv = process.argv.slice(2);
  const sportIdx = argv.indexOf('--sport');
  const sportFilter = sportIdx >= 0 ? String(argv[sportIdx + 1] || '').toLowerCase().trim() : null;
  const limitIdx = argv.indexOf('--limit');
  const limit = limitIdx >= 0 ? Math.max(1, Number(argv[limitIdx + 1] || 0)) : 250;

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const providers = await client.query(`select id, code from pmci.providers where code in ('kalshi','polymarket')`);
    const byCode = new Map(providers.rows.map((r) => [r.code, r.id]));
    const kalshiId = byCode.get('kalshi');
    const polyId = byCode.get('polymarket');

    const markets = await client.query(`
      select id, provider_id, provider_market_ref, event_ref, title, sport, game_date, home_team, away_team, status
      from pmci.provider_markets
      where category = 'sports'
        and coalesce(status,'') in ('active','open')
        and sport is not null
        and sport <> 'unknown'
        and game_date is not null
        and home_team is not null
        and away_team is not null
        and ($1::text is null or lower(sport) = $1)
      order by sport, game_date desc, id desc
    `, [sportFilter]);

    const grouped = new Map();
    for (const row of markets.rows) {
      if (!looksLikeMatchupMarket(row)) continue;
      const info = sportsEntityFromMarket(row);
      if (!info.signature || info.matchupKey === 'unknown' || !info.gameDate || !info.isMatchup) continue;
      const bucket = grouped.get(info.signature) || { kalshi: 0, polymarket: 0, sample: row, info };
      if (row.provider_id === kalshiId) bucket.kalshi += 1;
      if (row.provider_id === polyId) bucket.polymarket += 1;
      grouped.set(info.signature, bucket);
    }

    const eligible = [...grouped.values()]
      .filter((b) => b.kalshi > 0 && b.polymarket > 0)
      .slice(0, limit);

    let eventsTouched = 0;
    let familiesCreated = 0;
    const touched = new Set();

    for (const bucket of eligible) {
      const { info, sample } = bucket;
      const slug = `${info.sport}-${info.matchupKey}-${info.gameDate}`
        .replace(/[^a-z0-9:_-]/g, '-')
        .replace(/:/g, '-')
        .replace(/_+/g, '-');
      const title = `${sample.away_team || 'TBD'} vs ${sample.home_team || 'TBD'} ${info.gameDate}`;

      const ce = await client.query(
        `insert into pmci.canonical_events (slug, title, category, lifecycle)
         values ($1, $2, 'sports', 'active')
         on conflict (slug) do update set title = excluded.title
         returning id`,
        [slug, title],
      );
      const canonicalEventId = ce.rows[0].id;
      eventsTouched += 1;

      const label = `sports::${slug}`;
      const fam = await client.query(`select id from pmci.market_families where label = $1`, [label]);
      let familyId = fam.rows[0]?.id;
      if (!familyId) {
        const ins = await client.query(
          `insert into pmci.market_families (label, notes, canonical_event_id)
           values ($1, $2, $3)
           returning id`,
          [label, `auto-seeded sports family for ${slug}`, canonicalEventId],
        );
        familyId = ins.rows[0].id;
        familiesCreated += 1;
      }
      touched.add(familyId);
    }

    console.log(`seed:sports:pmci sport=${sportFilter || 'all'} eligible_cross_provider=${eligible.length} canonical_events_touched=${eventsTouched} families_created=${familiesCreated} families_touched=${touched.size} limit=${limit}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('seed:sports:pmci FAIL:', err.message);
  process.exit(1);
});
