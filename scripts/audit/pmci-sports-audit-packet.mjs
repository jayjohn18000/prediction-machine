#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { loadEnv } from '../../src/platform/env.mjs';

loadEnv();
const { Client } = pg;

async function q(client, sql, params = []) {
  const res = await client.query(sql, params);
  return res.rows;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const strict = process.argv.includes('--strict');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const providerCoverage = await q(client, `
      select sport, p.code as provider,
             count(distinct pm.id)::int as total,
             count(distinct pm.id) filter (where coalesce(pm.status,'') in ('active','open'))::int as active,
             count(distinct pm.id) filter (where pm.game_date < now()::date and coalesce(pm.status,'') in ('active','open'))::int as stale_active,
             count(distinct pm.id) filter (where coalesce(pm.sport,'unknown') = 'unknown')::int as unknown_sport
      from pmci.provider_markets pm
      join pmci.providers p on p.id = pm.provider_id
      where pm.category = 'sports'
      group by 1,2
      order by 1,2
    `);

    const proposalBuckets = await q(client, `
      select coalesce(decision,'(none)') as decision, count(*)::int as count
      from pmci.proposed_links
      where category = 'sports'
      group by 1
      order by 2 desc
    `);

    const semanticViolations = await q(client, `
      select count(*)::int as violations
      from pmci.proposed_links pl
      join pmci.provider_markets a on a.id = pl.provider_market_id_a
      join pmci.provider_markets b on b.id = pl.provider_market_id_b
      where pl.category = 'sports'
        and (
          coalesce(a.sport,'unknown') <> coalesce(b.sport,'unknown')
          or abs(a.game_date - b.game_date) > 1
        )
    `);

    const packet = {
      generatedAt: new Date().toISOString(),
      providerCoverage,
      proposalBuckets,
      semanticViolations: semanticViolations[0]?.violations ?? 0,
    };

    const outPath = path.resolve(process.cwd(), 'docs/reports/latest-sports-audit-packet.json');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(packet, null, 2)}\n`, 'utf8');

    const staleActive = providerCoverage.reduce((sum, row) => sum + Number(row.stale_active || 0), 0);
    const unknownSport = providerCoverage.reduce((sum, row) => sum + Number(row.unknown_sport || 0), 0);
    console.log(`pmci:audit:sports:packet wrote ${outPath}`);
    console.log(`sports_audit stale_active=${staleActive} unknown_sport=${unknownSport} semantic_violations=${packet.semanticViolations}`);

    if (strict && (staleActive > 0 || unknownSport > 0 || Number(packet.semanticViolations) > 0)) {
      process.exit(2);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('pmci:audit:sports:packet FAIL:', err.message);
  process.exit(1);
});
