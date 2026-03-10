#!/usr/bin/env node
/**
 * PMCI Polymarket snapshots check (politics universe sanity).
 *
 * Prints:
 * - polymarket provider_markets count
 * - polymarket provider_market_snapshots count
 * - latest polymarket observed_at
 * - universe_attributed count (snapshots with raw._pmci.source = 'pmci-ingest-politics-universe')
 * - price_source check: warns if any universe snapshot has null/missing raw._pmci.price_source
 * - price_source breakdown: counts by raw._pmci.price_source for universe snapshots
 *
 * Acceptance: still_missing_prices should decrease vs 364 after fallback; universe_attributed should increase.
 *
 * Exits non-zero if:
 * - provider 'polymarket' is missing, or
 * - polymarket provider_markets > 0 but snapshots == 0, or
 * - PMCI_REQUIRE_UNIVERSE_SNAPSHOTS=1 and universe_attributed == 0
 *
 * Env: DATABASE_URL (required), PMCI_REQUIRE_UNIVERSE_SNAPSHOTS (optional, set to 1 to require universe-attributed snapshots)
 */

import pg from 'pg';
import { loadEnv } from '../../src/platform/env.mjs';

const { Client } = pg;
loadEnv();

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error('DATABASE_URL is required. Set it in .env');
    process.exit(1);
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const provRes = await client.query(
      `select id from pmci.providers where code = 'polymarket'`,
    );
    if (provRes.rowCount === 0) {
      console.error("Provider 'polymarket' not found in pmci.providers");
      process.exit(1);
    }
    const providerId = provRes.rows[0].id;

    const countsRes = await client.query(
      `
      select
        (select count(*)::bigint
         from pmci.provider_markets pm
         where pm.provider_id = $1) as provider_markets,
        (select count(*)::bigint
         from pmci.provider_market_snapshots s
         join pmci.provider_markets pm on pm.id = s.provider_market_id
         where pm.provider_id = $1) as snapshots,
        (select max(s.observed_at)
         from pmci.provider_market_snapshots s
         join pmci.provider_markets pm on pm.id = s.provider_market_id
         where pm.provider_id = $1) as latest_observed_at
      `,
      [providerId],
    );
    const row = countsRes.rows?.[0] || {};
    const providerMarkets = Number(row.provider_markets ?? 0);
    const snapshots = Number(row.snapshots ?? 0);
    const latest = row.latest_observed_at ? String(row.latest_observed_at) : null;

    const universeRes = await client.query(
      `select count(*)::bigint as n from pmci.provider_market_snapshots s
       where (s.raw->'_pmci'->>'source') = 'pmci-ingest-politics-universe'`,
    );
    const universeSnapshots = Number(universeRes.rows?.[0]?.n ?? 0);

    // Count universe snapshots missing price_source (null or empty)
    const missingPriceSourceRes = await client.query(
      `select count(*)::bigint as n from pmci.provider_market_snapshots s
       where (s.raw->'_pmci'->>'source') = 'pmci-ingest-politics-universe'
         and ( (s.raw->'_pmci'->>'price_source') is null or (s.raw->'_pmci'->>'price_source') = '' )`,
    );
    const missingPriceSource = Number(missingPriceSourceRes.rows?.[0]?.n ?? 0);
    if (missingPriceSource > 0) {
      console.warn(
        'WARN: %d universe snapshot(s) lack raw._pmci.price_source (existing rows may predate this field)',
        missingPriceSource,
      );
    }

    // One-line price_source breakdown for universe snapshots
    const breakdownRes = await client.query(
      `select s.raw->'_pmci'->>'price_source' as ps, count(*)::bigint as n
       from pmci.provider_market_snapshots s
       where (s.raw->'_pmci'->>'source') = 'pmci-ingest-politics-universe'
       group by 1 order by 2 desc`,
    );
    const breakdown =
      breakdownRes.rows?.length > 0
        ? breakdownRes.rows.map((r) => `${r.ps ?? '(null)'}=${r.n}`).join(' ')
        : 'none';
    console.log(
      'PMCI Polymarket snapshots: provider_markets=%d snapshots=%d latest_observed_at=%s universe_attributed=%d',
      providerMarkets,
      snapshots,
      latest ?? 'null',
      universeSnapshots,
    );
    console.log('PMCI Polymarket universe price_source breakdown: %s', breakdown);

    if (providerMarkets > 0 && snapshots === 0) {
      console.error('FAIL: polymarket has provider_markets > 0 but snapshots == 0');
      process.exit(1);
    }

    const requireUniverse = process.env.PMCI_REQUIRE_UNIVERSE_SNAPSHOTS === '1';
    if (requireUniverse && universeSnapshots === 0) {
      console.error('FAIL: PMCI_REQUIRE_UNIVERSE_SNAPSHOTS=1 but universe_attributed snapshots == 0 (run pmci:ingest:politics:universe with observer OFF)');
      process.exit(1);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});

