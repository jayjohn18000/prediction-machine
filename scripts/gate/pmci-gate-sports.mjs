#!/usr/bin/env node
/**
 * pmci:gate:sports — single-command gate verification for the sports phase.
 *
 * Checks all E1/E2 gate criteria and prints a PASS/FAIL line per criterion,
 * then a final GATE: PASS or GATE: FAIL summary. Exits 0 on full pass, 1 on any failure.
 *
 * Criteria:
 *   1. stale_active     = 0   (no active markets with game_date in the past)
 *   2. unknown_sport    < 1000 (< 1000 sports markets with no sport inferred)
 *   3. semantic_violations = 0 (no accepted/proposed pairs with sport or date mismatch)
 *   4. verify:schema    PASS  (schema migration check)
 *   5. accepted_pairs   >= 5  (at least 5 accepted sports pairs in market_links)
 */

import { execSync } from 'node:child_process';
import pg from 'pg';
import { loadEnv } from '../../src/platform/env.mjs';

loadEnv();

const { Client } = pg;

function pass(label, detail = '') {
  console.log(`  [PASS] ${label}${detail ? '  (' + detail + ')' : ''}`);
}
function fail(label, detail = '') {
  console.log(`  [FAIL] ${label}${detail ? '  (' + detail + ')' : ''}`);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  let failures = 0;

  console.log('\npmci:gate:sports — verifying gate criteria\n');

  try {
    // ── Criterion 1: stale_active = 0 ────────────────────────────────────────
    const { rows: coverage } = await client.query(`
      SELECT
        coalesce(sum(
          (CASE WHEN pm.game_date < now()::date AND coalesce(pm.status,'') IN ('active','open') THEN 1 ELSE 0 END)
        ), 0)::int AS stale_active,
        coalesce(sum(
          (CASE WHEN coalesce(pm.sport,'unknown') = 'unknown' THEN 1 ELSE 0 END)
        ), 0)::int AS unknown_sport
      FROM pmci.provider_markets pm
      WHERE pm.category = 'sports'
    `);
    const staleActive  = Number(coverage[0]?.stale_active  ?? 0);
    const unknownSport = Number(coverage[0]?.unknown_sport ?? 0);

    if (staleActive === 0) {
      pass('stale_active = 0', `stale_active=${staleActive}`);
    } else {
      fail('stale_active = 0', `stale_active=${staleActive} (must be 0)`);
      failures++;
    }

    // ── Criterion 2: unknown_sport < 1000 ────────────────────────────────────
    if (unknownSport < 1000) {
      pass('unknown_sport < 1000', `unknown_sport=${unknownSport}`);
    } else {
      fail('unknown_sport < 1000', `unknown_sport=${unknownSport} (must be < 1000)`);
      failures++;
    }

    // ── Criterion 3: semantic_violations = 0 ─────────────────────────────────
    const { rows: semRows } = await client.query(`
      SELECT count(*)::int AS violations
      FROM pmci.proposed_links pl
      JOIN pmci.provider_markets a ON a.id = pl.provider_market_id_a
      JOIN pmci.provider_markets b ON b.id = pl.provider_market_id_b
      WHERE pl.category = 'sports'
        AND (
          coalesce(a.sport,'unknown') <> coalesce(b.sport,'unknown')
          OR abs(a.game_date - b.game_date) > 1
        )
    `);
    const semViolations = Number(semRows[0]?.violations ?? 0);

    if (semViolations === 0) {
      pass('semantic_violations = 0', `violations=${semViolations}`);
    } else {
      fail('semantic_violations = 0', `violations=${semViolations} (must be 0)`);
      failures++;
    }

    // ── Criterion 4: verify:schema PASS ──────────────────────────────────────
    try {
      execSync('npm run verify:schema --silent', { cwd: process.cwd(), stdio: 'pipe' });
      pass('verify:schema PASS');
    } catch {
      fail('verify:schema PASS', 'schema verification failed — run npm run verify:schema for details');
      failures++;
    }

    // ── Criterion 5: accepted_pairs >= 5 ─────────────────────────────────────
    const { rows: pairRows } = await client.query(`
      SELECT count(DISTINCT ml.family_id)::int AS accepted_pairs
      FROM pmci.market_links ml
      JOIN pmci.provider_markets pm ON pm.id = ml.provider_market_id
      WHERE pm.category = 'sports'
        AND ml.status = 'active'
    `);
    const acceptedPairs = Number(pairRows[0]?.accepted_pairs ?? 0);

    if (acceptedPairs >= 5) {
      pass('accepted_pairs >= 5', `accepted_pairs=${acceptedPairs}`);
    } else {
      fail('accepted_pairs >= 5', `accepted_pairs=${acceptedPairs} (need >= 5)`);
      failures++;
    }

  } finally {
    await client.end();
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('');
  if (failures === 0) {
    console.log('GATE: PASS');
    process.exit(0);
  } else {
    console.log(`GATE: FAIL (${failures} criterion${failures === 1 ? '' : 'ia'} failed)`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('pmci:gate:sports ERROR:', err.message);
  process.exit(1);
});
