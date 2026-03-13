#!/usr/bin/env node
import 'dotenv/config';
import pg from 'pg';

const { Client } = pg;

const outJson = process.argv.includes('--json');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    const byVenue = await client.query(`
      with pm as (
        select p.code as venue, pm.*
        from pmci.provider_markets pm
        join pmci.providers p on p.id = pm.provider_id
        where coalesce(pm.category,'')='politics'
          and lower(coalesce(pm.status,'open')) in ('open','active')
      )
      select venue, count(distinct event_ref) as open_events, count(*) as open_markets
      from pm
      group by 1
      order by 1;
    `);

    const bySubjectType = await client.query(`
      select coalesce(subject_type,'null') as subject_type, count(*) as count
      from pmci.provider_markets
      where coalesce(category,'')='politics'
        and lower(coalesce(status,'open')) in ('open','active')
      group by 1
      order by 2 desc;
    `);

    const byElectionPhase = await client.query(`
      select coalesce(election_phase,'null') as election_phase, count(*) as count
      from pmci.provider_markets
      where coalesce(category,'')='politics'
        and lower(coalesce(status,'open')) in ('open','active')
      group by 1
      order by 2 desc;
    `);

    const byOffice = await client.query(`
      select coalesce(metadata->>'office','null') as office, count(*) as count
      from pmci.provider_markets
      where coalesce(category,'')='politics'
        and lower(coalesce(status,'open')) in ('open','active')
      group by 1
      order by 2 desc;
    `);

    const samples = await client.query(`
      select p.code as venue,
             pm.event_ref,
             pm.provider_market_ref,
             pm.title,
             pm.subject_type,
             pm.election_phase,
             pm.metadata->>'normalized_event_key' as normalized_event_key,
             pm.metadata->>'jurisdiction' as jurisdiction,
             pm.metadata->>'year' as year
      from pmci.provider_markets pm
      join pmci.providers p on p.id = pm.provider_id
      where coalesce(pm.category,'')='politics'
        and lower(coalesce(pm.status,'open')) in ('open','active')
      order by pm.last_seen_at desc nulls last
      limit 12;
    `);

    const snapshot = {
      generated_at: new Date().toISOString(),
      by_venue: byVenue.rows,
      by_subject_type: bySubjectType.rows,
      by_election_phase: byElectionPhase.rows,
      by_office: byOffice.rows,
      sample_normalized_markets: samples.rows,
    };

    if (outJson) {
      console.log(JSON.stringify(snapshot, null, 2));
      return;
    }

    console.log('Politics health snapshot');
    console.log(JSON.stringify(snapshot, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('health:politics:snapshot FAIL:', err.message);
  process.exit(1);
});
