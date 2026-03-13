#!/usr/bin/env node
/**
 * Repeatable politics audit packet (closeout-focused).
 * Includes: coverage, series stats, stale/orphans, review buckets, and integrity guards.
 */

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { loadEnv } from '../../src/platform/env.mjs';

loadEnv();

const { Client } = pg;
const asJson = process.argv.includes('--json');
const strict = process.argv.includes('--strict');

function topicCase(columnRef = 'pm.provider_market_ref', titleRef = 'pm.title') {
  return `
    CASE
      WHEN ${columnRef} ILIKE 'GOVPARTY%' OR ${titleRef} ILIKE '%governor%' THEN 'governor'
      WHEN ${columnRef} ILIKE 'SENATE%' OR ${titleRef} ILIKE '%senate%' THEN 'senate'
      WHEN ${columnRef} ILIKE 'PRES%' OR ${titleRef} ILIKE '%president%' THEN 'president'
      ELSE 'other'
    END`;
}

async function q(client, sql, params = []) {
  const res = await client.query(sql, params);
  return res.rows;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();

  try {
    const providerMapRows = await q(client, 'SELECT id, code FROM pmci.providers ORDER BY id');
    const providerMap = new Map(providerMapRows.map((r) => [r.id, r.code]));

    const byProviderStatus = await q(client, `
      SELECT p.code AS provider, COALESCE(pm.status, '(null)') AS status, COUNT(*)::int AS count
      FROM pmci.provider_markets pm
      JOIN pmci.providers p ON p.id = pm.provider_id
      WHERE COALESCE(pm.category, '') = 'politics'
      GROUP BY 1,2
      ORDER BY 1,2
    `);

    const activeByProvider = await q(client, `
      SELECT p.code AS provider, COUNT(*)::int AS active_markets
      FROM pmci.provider_markets pm
      JOIN pmci.providers p ON p.id = pm.provider_id
      WHERE COALESCE(pm.category, '') = 'politics'
        AND ((p.code='kalshi' AND pm.status='active') OR (p.code='polymarket' AND pm.status='open'))
      GROUP BY 1
      ORDER BY 1
    `);

    const linksMeta = await q(client, `
      SELECT
        (SELECT COUNT(*)::int FROM pmci.market_links WHERE status='active') AS active_link_rows,
        (SELECT COUNT(*)::int FROM (
          SELECT family_id FROM pmci.market_links WHERE status='active' GROUP BY family_id HAVING COUNT(DISTINCT provider_id) >= 2
        ) t) AS cross_provider_families
    `);

    const linkByTopic = await q(client, `
      SELECT
        ${topicCase()} AS topic,
        p.code AS provider,
        COUNT(DISTINCT pm.id)::int AS total,
        COUNT(DISTINCT ml.id)::int AS linked,
        ROUND(COUNT(DISTINCT ml.id)::numeric / NULLIF(COUNT(DISTINCT pm.id),0), 3) AS link_rate
      FROM pmci.provider_markets pm
      JOIN pmci.providers p ON p.id = pm.provider_id
      LEFT JOIN pmci.market_links ml ON ml.provider_market_id = pm.id AND ml.status='active'
      WHERE COALESCE(pm.category, '')='politics'
        AND ((p.code='kalshi' AND pm.status='active') OR (p.code='polymarket' AND pm.status='open'))
      GROUP BY 1,2
      ORDER BY 1,2
    `);

    const eventsPerSeries = await q(client, `
      SELECT split_part(pm.provider_market_ref,'-',1) AS series_family,
             COUNT(DISTINCT COALESCE(pm.event_ref, pm.provider_market_ref))::int AS events,
             COUNT(*)::int AS markets
      FROM pmci.provider_markets pm
      JOIN pmci.providers p ON p.id = pm.provider_id
      WHERE p.code='kalshi' AND COALESCE(pm.category,'')='politics' AND pm.status='active'
      GROUP BY 1
      ORDER BY 2 DESC, 1
      LIMIT 30
    `);

    const staleSeries = await q(client, `
      SELECT split_part(pm.provider_market_ref,'-',1)||'-'||split_part(pm.provider_market_ref,'-',2) AS series_prefix,
             MAX(pm.last_seen_at) AS last_seen,
             COUNT(*)::int AS markets
      FROM pmci.provider_markets pm
      JOIN pmci.providers p ON p.id = pm.provider_id
      WHERE p.code='kalshi' AND COALESCE(pm.category,'')='politics'
      GROUP BY 1
      HAVING MAX(pm.last_seen_at) < NOW() - INTERVAL '7 days'
      ORDER BY MAX(pm.last_seen_at) ASC
      LIMIT 50
    `);

    const orphans = await q(client, `
      SELECT p.code AS provider, COUNT(*)::int AS orphaned
      FROM pmci.provider_markets pm
      JOIN pmci.providers p ON p.id = pm.provider_id
      LEFT JOIN pmci.market_links ml ON ml.provider_market_id = pm.id AND ml.status='active'
      WHERE COALESCE(pm.category,'')='politics'
        AND ((p.code='kalshi' AND pm.status='active') OR (p.code='polymarket' AND pm.status='open'))
        AND ml.id IS NULL
      GROUP BY 1
      ORDER BY 1
    `);

    const reviewBuckets = await q(client, `
      SELECT COALESCE(decision,'(none)') AS decision, COUNT(*)::int AS count
      FROM pmci.proposed_links
      GROUP BY 1
      ORDER BY 2 DESC
    `);

    // Integrity guard #1: high-salience presidential party events marked poly_only with plausible active Kalshi counterpart
    const polyOnlyPresParty = await q(client, `
      SELECT ce.id, ce.title, COUNT(pm.id)::int AS plausible_kalshi
      FROM pmci.canonical_events ce
      JOIN pmci.provider_markets pm ON pm.status='active' AND COALESCE(pm.category,'')='politics'
      JOIN pmci.providers p ON p.id = pm.provider_id AND p.code='kalshi'
      WHERE ce.source_annotation='poly_only'
        AND lower(ce.title) ~ '(president|presidential)'
        AND lower(ce.title) ~ '(party|democrat|republican)'
        AND lower(ce.title) ~ '2028'
        AND (
          pm.provider_market_ref ILIKE 'PRESPARTY%'
          OR pm.provider_market_ref ILIKE 'PRES%'
          OR lower(pm.title) ~ '(president|presidential)'
        )
      GROUP BY ce.id, ce.title
      HAVING COUNT(pm.id) > 0
      ORDER BY plausible_kalshi DESC
      LIMIT 20
    `);

    // Integrity guard #2: TX-33 style deletion risk (both venues present but unlinked)
    const tx33Risk = await q(client, `
      WITH k AS (
        SELECT pm.id, pm.provider_market_ref, pm.title
        FROM pmci.provider_markets pm
        JOIN pmci.providers p ON p.id=pm.provider_id
        WHERE p.code='kalshi' AND COALESCE(pm.category,'')='politics' AND pm.status IN ('active','open')
          AND (lower(pm.provider_market_ref) LIKE '%tx-33%' OR lower(pm.title) LIKE '%tx-33%' OR lower(pm.provider_market_ref) LIKE '%house-tx-33%')
      ),
      m AS (
        SELECT pm.id, pm.provider_market_ref, pm.title
        FROM pmci.provider_markets pm
        JOIN pmci.providers p ON p.id=pm.provider_id
        WHERE p.code='polymarket' AND COALESCE(pm.category,'')='politics' AND pm.status='open'
          AND (lower(pm.provider_market_ref) LIKE '%tx-33%' OR lower(pm.title) LIKE '%tx-33%' OR lower(pm.provider_market_ref) LIKE '%house-tx-33%')
      )
      SELECT (SELECT COUNT(*)::int FROM k) AS kalshi_rows,
             (SELECT COUNT(*)::int FROM m) AS poly_rows,
             (
               SELECT COUNT(*)::int
               FROM pmci.market_links ml
               WHERE ml.status='active' AND ml.provider_market_id IN (SELECT id FROM k UNION SELECT id FROM m)
             ) AS link_rows
    `);

    const sampleLinks = await q(client, `
      WITH fam AS (
        SELECT family_id
        FROM pmci.market_links
        WHERE status='active'
        GROUP BY family_id
        HAVING COUNT(DISTINCT provider_id) >= 2
      ),
      k AS (
        SELECT ml.family_id, pm.provider_market_ref, pm.title
        FROM pmci.market_links ml
        JOIN pmci.provider_markets pm ON pm.id = ml.provider_market_id
        JOIN pmci.providers p ON p.id = ml.provider_id
        WHERE ml.status='active' AND p.code='kalshi'
      ),
      m AS (
        SELECT ml.family_id, pm.provider_market_ref, pm.title
        FROM pmci.market_links ml
        JOIN pmci.provider_markets pm ON pm.id = ml.provider_market_id
        JOIN pmci.providers p ON p.id = ml.provider_id
        WHERE ml.status='active' AND p.code='polymarket'
      )
      SELECT f.family_id, k.provider_market_ref AS kalshi_ref, k.title AS kalshi_title,
             m.provider_market_ref AS poly_ref, m.title AS poly_title
      FROM fam f
      JOIN k ON k.family_id=f.family_id
      JOIN m ON m.family_id=f.family_id
      ORDER BY f.family_id DESC
      LIMIT 20
    `);

    const packet = {
      generatedAt: new Date().toISOString(),
      providerStatus: byProviderStatus,
      activeByProvider,
      links: linksMeta[0] || { active_link_rows: 0, cross_provider_families: 0 },
      linkRateByTopic: linkByTopic,
      eventsPerSeries,
      staleSeries,
      orphans,
      reviewBuckets,
      integrityWarnings: {
        poly_only_pres_party_with_plausible_kalshi: polyOnlyPresParty,
        tx33_or_house_tx33_unlinked_risk: tx33Risk[0] || { kalshi_rows: 0, poly_rows: 0, link_rows: 0 },
      },
      sampleLinks,
    };

    const outPath = path.resolve(process.cwd(), 'docs/reports/latest-politics-audit-packet.json');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(packet, null, 2)}\n`, 'utf8');

    if (asJson) {
      console.log(JSON.stringify(packet, null, 2));
    } else {
      console.log(`pmci:audit:packet wrote ${outPath}`);
      console.log(`active kalshi=${activeByProvider.find((x) => x.provider === 'kalshi')?.active_markets ?? 0} polymarket=${activeByProvider.find((x) => x.provider === 'polymarket')?.active_markets ?? 0}`);
      console.log(`links active_rows=${packet.links.active_link_rows} cross_provider_families=${packet.links.cross_provider_families}`);
      console.log(`integrity warnings: poly_only_pres_party=${polyOnlyPresParty.length} tx33_rows=${tx33Risk[0]?.kalshi_rows || 0}/${tx33Risk[0]?.poly_rows || 0} linked=${tx33Risk[0]?.link_rows || 0}`);
    }

    const hasIntegrityWarnings = polyOnlyPresParty.length > 0 || Number(tx33Risk[0]?.kalshi_rows || 0) + Number(tx33Risk[0]?.poly_rows || 0) > 0 && Number(tx33Risk[0]?.link_rows || 0) === 0;
    if (strict && hasIntegrityWarnings) process.exit(2);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('pmci:audit:packet FAIL:', err.message);
  process.exit(1);
});
