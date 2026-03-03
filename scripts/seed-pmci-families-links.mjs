#!/usr/bin/env node
/**
 * Seed pmci.market_families and pmci.market_links from event_pairs config.
 * Uses provider_markets populated by the observer (run observer first or ensure markets exist).
 * Idempotent: skips pairs that already have links; creates new link_version per run when adding links.
 * Env: DATABASE_URL
 */

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const { Client } = pg;

const SQL_GET_PROVIDER_IDS = `
  SELECT id, code FROM pmci.providers WHERE code IN ('kalshi', 'polymarket');
`;
function loadEnv() {
  const envPath = path.join(process.cwd(), '.env');
  try {
    const env = fs.readFileSync(envPath, 'utf8');
    env.split('\n').forEach((line) => {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
    });
  } catch (_) {}
}
loadEnv();

function loadPairs() {
  const candidates = [
    path.join(process.cwd(), 'scripts', 'prediction_market_event_pairs.json'),
    path.join(process.cwd(), 'event_pairs.json'),
  ];
  for (const p of candidates) {
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length > 0) return arr;
    } catch (_) {}
  }
  return [];
}

const SQL_GET_MARKET_ID = `
  SELECT id FROM pmci.provider_markets
  WHERE provider_id = $1 AND provider_market_ref = $2;
`;
const SQL_UPSERT_CANONICAL_EVENT = `
  INSERT INTO pmci.canonical_events (slug, title, category)
  VALUES ($1, $2, $3)
  ON CONFLICT (slug) DO UPDATE SET title = EXCLUDED.title, category = EXCLUDED.category
  RETURNING id, slug;
`;
const SQL_GET_FAMILY_BY_LABEL = `
  SELECT id, canonical_event_id FROM pmci.market_families WHERE label = $1;
`;
const SQL_INSERT_FAMILY = `
  INSERT INTO pmci.market_families (label, notes, canonical_event_id)
  VALUES ($1, $2, $3)
  RETURNING id;
`;
const SQL_UPDATE_FAMILY_CANONICAL_EVENT = `
  UPDATE pmci.market_families SET canonical_event_id = $2 WHERE id = $1;
`;
const SQL_LINKS_FOR_FAMILY = `
  SELECT provider_market_id FROM pmci.market_links
  WHERE family_id = $1 AND status = 'active';
`;
const SQL_NEXT_VERSION = `
  SELECT COALESCE(MAX(version), 0) + 1 AS v FROM pmci.linker_runs;
`;
const SQL_INSERT_LINKER_RUN = `
  INSERT INTO pmci.linker_runs (version, description) VALUES ($1, $2) RETURNING version;
`;
const SQL_INSERT_LINK = `
  INSERT INTO pmci.market_links (
    family_id, provider_id, provider_market_id, relationship_type, status,
    link_version, confidence, reasons
  ) VALUES ($1, $2, $3, 'equivalent', 'active', $4, 0.99, $5::jsonb)
  RETURNING id;
`;

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error('DATABASE_URL is required. Set it in .env');
    process.exit(1);
  }

  const pairs = loadPairs();
  if (pairs.length === 0) {
    console.error('No event pairs found in scripts/prediction_market_event_pairs.json or event_pairs.json');
    process.exit(1);
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  const providerRes = await client.query(SQL_GET_PROVIDER_IDS);
  const byCode = new Map((providerRes.rows || []).map((r) => [r.code, r.id]));
  const providerIdKalshi = byCode.get('kalshi') ?? null;
  const providerIdPolymarket = byCode.get('polymarket') ?? null;
  if (providerIdKalshi == null || providerIdPolymarket == null) {
    console.error('pmci.providers must have rows with code kalshi and polymarket. Run migrations.');
    await client.end();
    process.exit(1);
  }

  const report = { familiesCreated: 0, familiesSkipped: 0, linksInserted: 0, pairsSkippedMissingMarket: 0, pairsSkippedHasLinks: 0 };

  try {
    const distinctSlugs = [...new Set(pairs.map((p) => p.polymarketSlug))];
    const slugToTitle = {
      'democratic-presidential-nominee-2028': 'Democratic presidential nominee 2028',
      'republican-presidential-nominee-2028': 'Republican presidential nominee 2028',
    };
    const slugToUuid = new Map();
    for (const slug of distinctSlugs) {
      const title = slugToTitle[slug] || slug.replace(/-/g, ' ');
      const res = await client.query(SQL_UPSERT_CANONICAL_EVENT, [slug, title, 'politics']);
      if (res.rows?.[0]) slugToUuid.set(res.rows[0].slug, res.rows[0].id);
    }
    if (slugToUuid.size > 0) {
      console.log('Canonical events (use these UUIDs for /v1/market-families?event_id=):');
      for (const [slug, uuid] of slugToUuid) {
        console.log(`  ${slug} => ${uuid}`);
      }
    }

    let linkVersion = null;

    for (const pair of pairs) {
      const eventId = pair.polymarketSlug;
      const candidate = pair.polymarketOutcomeName;
      const label = `${eventId}::${candidate}`;
      const polymarketRef = `${pair.polymarketSlug}#${pair.polymarketOutcomeName}`;

      const kalshiRes = await client.query(SQL_GET_MARKET_ID, [providerIdKalshi, pair.kalshiTicker]);
      const polyRes = await client.query(SQL_GET_MARKET_ID, [providerIdPolymarket, polymarketRef]);
      const kalshiMarketId = kalshiRes.rows?.[0]?.id;
      const polyMarketId = polyRes.rows?.[0]?.id;

      if (kalshiMarketId == null || polyMarketId == null) {
        report.pairsSkippedMissingMarket += 1;
        continue;
      }

      const canonicalEventId = slugToUuid.get(eventId) ?? null;
      const familyRow = (await client.query(SQL_GET_FAMILY_BY_LABEL, [label])).rows?.[0];
      let familyId = familyRow?.id;
      if (familyId == null) {
        const ins = await client.query(SQL_INSERT_FAMILY, [label, `event_id=${eventId} candidate=${candidate}`, canonicalEventId]);
        familyId = ins.rows?.[0]?.id;
        if (familyId != null) report.familiesCreated += 1;
      } else {
        report.familiesSkipped += 1;
        if (canonicalEventId != null && familyRow?.canonical_event_id == null) {
          await client.query(SQL_UPDATE_FAMILY_CANONICAL_EVENT, [familyId, canonicalEventId]);
        }
      }
      if (familyId == null) continue;

      const existing = await client.query(SQL_LINKS_FOR_FAMILY, [familyId]);
      const existingIds = new Set((existing.rows || []).map((r) => r.provider_market_id));
      if (existingIds.has(kalshiMarketId) && existingIds.has(polyMarketId)) {
        report.pairsSkippedHasLinks += 1;
        continue;
      }

      if (linkVersion == null) {
        const vRes = await client.query(SQL_NEXT_VERSION);
        linkVersion = Number(vRes.rows?.[0]?.v ?? 1);
        await client.query(SQL_INSERT_LINKER_RUN, [linkVersion, 'seed from event_pairs']);
      }

      const reasons = {
        mapping_source: 'event_pairs',
        event_id: eventId,
        candidate,
        event_name: pair.eventName,
      };

      if (!existingIds.has(kalshiMarketId)) {
        await client.query(SQL_INSERT_LINK, [familyId, providerIdKalshi, kalshiMarketId, linkVersion, JSON.stringify(reasons)]);
        report.linksInserted += 1;
      }
      if (!existingIds.has(polyMarketId)) {
        await client.query(SQL_INSERT_LINK, [familyId, providerIdPolymarket, polyMarketId, linkVersion, JSON.stringify(reasons)]);
        report.linksInserted += 1;
      }
    }

    // Seed additional canonical events for broader political universe markets.
    // These are not in event_pairs.json but exist in pmci.provider_markets from universe ingestion.
    // The proposer uses canonicalSlugs to attach canonical_event_id when auto-accepting pairs.
    const ADDITIONAL_POLITICAL_EVENTS = [
      ['presidential-election-winner-2028', '2028 US Presidential Election Winner'],
      ['which-party-wins-2028-us-presidential-election', '2028 US Presidential Election - Party Winner'],
      ['who-will-trump-nominate-as-fed-chair', 'Federal Reserve Chair Nomination'],
    ];
    let additionalSeeded = 0;
    for (const [slug, title] of ADDITIONAL_POLITICAL_EVENTS) {
      if (!slugToUuid.has(slug)) {
        const res = await client.query(SQL_UPSERT_CANONICAL_EVENT, [slug, title, 'politics']);
        if (res.rows?.[0]) {
          slugToUuid.set(res.rows[0].slug, res.rows[0].id);
          console.log(`  Additional canonical event: ${slug} => ${res.rows[0].id}`);
          additionalSeeded += 1;
        }
      }
    }

    console.log('PMCI seed report:');
    console.log('  canonical_events_ensured:', slugToUuid.size);
    console.log('  canonical_events_additional:', additionalSeeded);
    console.log('  families_created:', report.familiesCreated);
    console.log('  families_skipped (existed):', report.familiesSkipped);
    console.log('  links_inserted:', report.linksInserted);
    console.log('  pairs_skipped_missing_market:', report.pairsSkippedMissingMarket);
    console.log('  pairs_skipped_has_links:', report.pairsSkippedHasLinks);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
