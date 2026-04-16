#!/usr/bin/env node
/**
 * PMCI auto-accept audit trip-wire — Phase E2.
 *
 * Reads pmci.proposed_links where decision='accept' and reviewed_at > now() - 1h
 * (i.e. the acceptances this run just performed), and for each accepted pair:
 *
 *  - Both provider markets still have status IN ('active','open') in provider_markets
 *  - accepted_relationship_type (or proposed_relationship_type) = 'equivalent'
 *  - Category on both provider_markets matches the proposed category
 *
 * On any violation: print the offending row and exit 1 so CI / cron halts.
 * Otherwise: exit 0 with `audit:pass violations=0 checked=N`.
 *
 * Env:
 *   DATABASE_URL required
 *   PMCI_AUTO_ACCEPT_AUDIT_WINDOW_MINUTES (default 60) — how far back to check
 */

import pg from 'pg';
import { loadEnv } from '../../src/platform/env.mjs';

const { Client } = pg;
loadEnv();

const WINDOW_MIN = Number(process.env.PMCI_AUTO_ACCEPT_AUDIT_WINDOW_MINUTES ?? 60);

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error('auto-accept-audit: DATABASE_URL required');
    process.exit(1);
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const violations = [];
  let checked = 0;

  try {
    const res = await client.query(
      `SELECT pl.id, pl.category, pl.provider_market_id_a, pl.provider_market_id_b,
              pl.proposed_relationship_type, pl.accepted_relationship_type, pl.confidence,
              pl.reviewed_at,
              pma.status AS status_a, pma.category AS category_a,
              pmb.status AS status_b, pmb.category AS category_b
         FROM pmci.proposed_links pl
         LEFT JOIN pmci.provider_markets pma ON pma.id = pl.provider_market_id_a
         LEFT JOIN pmci.provider_markets pmb ON pmb.id = pl.provider_market_id_b
        WHERE pl.decision = 'accepted'
          AND pl.reviewed_at > now() - ($1 || ' minutes')::interval
          AND pl.category = ANY($2::text[])`,
      [String(WINDOW_MIN), ['crypto', 'economics']],
    );

    for (const row of res.rows) {
      checked += 1;
      const failures = [];

      if (!['active', 'open'].includes(row.status_a)) {
        failures.push(`leg_a_status=${row.status_a}`);
      }
      if (!['active', 'open'].includes(row.status_b)) {
        failures.push(`leg_b_status=${row.status_b}`);
      }
      const effectiveType = row.accepted_relationship_type || row.proposed_relationship_type;
      if (effectiveType !== 'equivalent') {
        failures.push(`relationship_type=${effectiveType}`);
      }
      if (row.category_a !== row.category) {
        failures.push(`leg_a_category=${row.category_a}_expected=${row.category}`);
      }
      if (row.category_b !== row.category) {
        failures.push(`leg_b_category=${row.category_b}_expected=${row.category}`);
      }

      if (failures.length > 0) {
        violations.push({
          proposed_id: row.id,
          category: row.category,
          confidence: row.confidence,
          failures,
        });
      }
    }
  } finally {
    await client.end();
  }

  if (violations.length > 0) {
    console.error(`auto-accept-audit: FAIL violations=${violations.length} checked=${checked}`);
    for (const v of violations) {
      console.error(`  proposed_id=${v.proposed_id} category=${v.category} confidence=${v.confidence} failures=${v.failures.join(',')}`);
    }
    process.exit(1);
  }

  console.log(`auto-accept-audit: pass violations=0 checked=${checked}`);
}

main().catch((err) => {
  console.error('auto-accept-audit: fatal', err);
  process.exit(1);
});
