#!/usr/bin/env node
/**
 * Database audit for prediction-machine / PMCI.
 *
 * Focus:
 * - Data quality: orphans, duplicates, price bounds, empty markets.
 * - Lightweight structural checks for edge-related objects.
 *
 * Env: DATABASE_URL (Postgres connection string; uses src/platform/env.mjs)
 */

import pg from 'pg';
import { loadEnv } from '../src/platform/env.mjs';

const { Client } = pg;

loadEnv();

function getDatabaseUrl() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error('DATABASE_URL is required. Set it in .env');
  }
  return url;
}

/** Run a single-row, single-column COUNT(*) style query and return a number. */
async function fetchCount(client, label, sql) {
  const res = await client.query(sql);
  const row = res.rows?.[0] ?? {};
  // Pick the first column value
  const firstKey = Object.keys(row)[0];
  const raw = firstKey ? row[firstKey] : 0;
  const n = Number(raw ?? 0);
  if (!Number.isFinite(n)) {
    throw new Error(`Unexpected non-numeric result for ${label}: ${raw}`);
  }
  return n;
}

async function main() {
  const databaseUrl = getDatabaseUrl();
  const client = new Client({ connectionString: databaseUrl });

  console.log('DB audit starting...');

  await client.connect();

  const findings = {
    structural: {},
    data: {},
  };

  try {
    //
    // Structural checks (lightweight)
    //
    {
      const matviewRes = await client.query(
        `select 1
         from pg_matviews
         where schemaname = 'public' and matviewname = 'execution_signal_quality'`,
      );
      findings.structural.execution_signal_quality_exists = matviewRes.rowCount > 0;

      const viewsRes = await client.query(
        `select table_name
           from information_schema.views
          where table_schema = 'public'
            and table_name = any($1::text[])`,
        [['execution_signal_calibrated', 'edge_windows', 'edge_windows_generation', 'executable_edges_feed']],
      );
      const existingViews = new Set(viewsRes.rows.map((r) => r.table_name));
      findings.structural.views = {
        execution_signal_calibrated: existingViews.has('execution_signal_calibrated'),
        edge_windows: existingViews.has('edge_windows'),
        edge_windows_generation: existingViews.has('edge_windows_generation'),
        executable_edges_feed: existingViews.has('executable_edges_feed'),
      };
    }

    //
    // Data quality checks
    //
    const [
      orphanSnapshots,
      marketsWithoutSnapshots,
      outOfRangePriceYes,
      outOfRangePriceNo,
      duplicateProviderMarkets,
      orphanProposedLinks,
    ] = await Promise.all([
      fetchCount(
        client,
        'orphan_snapshots',
        `
        select count(*) as count
        from pmci.provider_market_snapshots s
        where not exists (
          select 1
          from pmci.provider_markets pm
          where pm.id = s.provider_market_id
        )
      `,
      ),
      fetchCount(
        client,
        'markets_without_snapshots',
        `
        select count(*) as count
        from pmci.provider_markets pm
        left join pmci.provider_market_snapshots s
          on s.provider_market_id = pm.id
        where s.id is null
      `,
      ),
      fetchCount(
        client,
        'out_of_range_price_yes',
        `
        select count(*) as count
        from pmci.provider_market_snapshots
        where price_yes is not null
          and (price_yes < 0 or price_yes > 1)
      `,
      ),
      fetchCount(
        client,
        'out_of_range_price_no',
        `
        select count(*) as count
        from pmci.provider_market_snapshots
        where price_no is not null
          and (price_no < 0 or price_no > 1)
      `,
      ),
      fetchCount(
        client,
        'duplicate_provider_markets',
        `
        select count(*) as count
        from (
          select provider_id, provider_market_ref, count(*) as c
          from pmci.provider_markets
          group by provider_id, provider_market_ref
          having count(*) > 1
        ) dup
      `,
      ),
      fetchCount(
        client,
        'orphan_proposed_links',
        `
        select count(*) as count
        from pmci.proposed_links pl
        where not exists (
                select 1 from pmci.provider_markets pm
                where pm.id = pl.provider_market_id_a
              )
           or not exists (
                select 1 from pmci.provider_markets pm
                where pm.id = pl.provider_market_id_b
              )
      `,
      ),
    ]);

    findings.data = {
      orphanSnapshots,
      marketsWithoutSnapshots,
      outOfRangePriceYes,
      outOfRangePriceNo,
      duplicateProviderMarkets,
      orphanProposedLinks,
    };

    //
    // Reporting
    //
    console.log('\nStructural:');
    console.log('  execution_signal_quality exists:', findings.structural.execution_signal_quality_exists);
    console.log('  views:', findings.structural.views);

    console.log('\nData quality (pmci):');
    console.log('  orphan_snapshots:', orphanSnapshots);
    console.log('  markets_without_snapshots:', marketsWithoutSnapshots);
    console.log('  out_of_range_price_yes:', outOfRangePriceYes);
    console.log('  out_of_range_price_no:', outOfRangePriceNo);
    console.log('  duplicate_provider_markets:', duplicateProviderMarkets);
    console.log('  orphan_proposed_links:', orphanProposedLinks);

    //
    // Exit code policy:
    // - Critical: orphans, duplicates, or out-of-range prices → non-zero.
    // - markets_without_snapshots is informational only.
    //
    const criticalIssues =
      orphanSnapshots > 0 ||
      outOfRangePriceYes > 0 ||
      outOfRangePriceNo > 0 ||
      duplicateProviderMarkets > 0 ||
      orphanProposedLinks > 0;

    if (criticalIssues) {
      console.error('\nDB audit: FAIL (see counts above).');
      process.exitCode = 1;
    } else {
      console.log('\nDB audit: PASS (no critical issues detected).');
      process.exitCode = 0;
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('DB audit error:', err.message);
  process.exit(1);
});

