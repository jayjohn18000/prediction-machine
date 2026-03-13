#!/usr/bin/env node
import 'dotenv/config';
import pg from 'pg';
import { inferPoliticalMetadata } from '../../lib/ingestion/services/market-metadata.mjs';

const { Client } = pg;

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    const { rows } = await client.query(`
      select id, event_ref, title, metadata, election_phase, subject_type
      from pmci.provider_markets
      where coalesce(category,'')='politics'
        and lower(coalesce(status,'open')) in ('open','active')
        and (
          election_phase is null
          or subject_type is null
          or metadata->>'normalized_event_key' is null
          or metadata->>'office' is null
          or metadata->>'jurisdiction' is null
          or metadata->>'year' is null
        )
      order by id asc
      limit 5000;
    `);

    let updated = 0;
    for (const row of rows) {
      const inferred = inferPoliticalMetadata(row.event_ref, row.title);
      const metadata = {
        ...(row.metadata || {}),
        normalized_event_key: inferred.normalizedEventKey,
        office: inferred.office,
        jurisdiction: inferred.jurisdiction,
        year: inferred.year,
      };

      const res = await client.query(
        `update pmci.provider_markets
         set election_phase = coalesce(election_phase, $2),
             subject_type = coalesce(subject_type, $3),
             metadata = $4::jsonb
         where id = $1`,
        [row.id, inferred.electionPhase, inferred.subjectType, JSON.stringify(metadata)],
      );
      updated += res.rowCount || 0;
    }

    console.log(`pmci:backfill:politics-normalization scanned=${rows.length} updated=${updated}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('pmci:backfill:politics-normalization FAIL:', err.message);
  process.exit(1);
});
