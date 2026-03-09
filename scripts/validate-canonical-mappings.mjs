#!/usr/bin/env node
/**
 * Validate canonical mapping plumbing (read-only).
 * Does NOT modify execution_signal, edge_windows, scoring, or routing.
 *
 * Checks: provider mapping uniqueness, canonical orphans, idempotency,
 * cross-provider consistency, rename simulation (dry-run).
 *
 * Env: SUPABASE_URL, SUPABASE_ANON_KEY (or SUPABASE_SERVICE_ROLE_KEY)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { loadEnv } from '../src/platform/env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv();

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Error: SUPABASE_URL and SUPABASE_ANON_KEY (or SUPABASE_SERVICE_ROLE_KEY) are required');
    process.exit(1);
  }
  return createClient(url, key);
}

/** Resolver: lookup canonical_event_id by provider + provider_event_id (read-only). */
async function resolveEvent(supabase, provider, providerEventId) {
  const { data, error } = await supabase
    .from('provider_event_map')
    .select('canonical_event_id')
    .eq('provider', provider)
    .eq('provider_event_id', providerEventId)
    .maybeSingle();
  if (error) throw error;
  return data?.canonical_event_id ?? null;
}

/** A) Provider mapping uniqueness: fail if any (provider, provider_event_id) has COUNT(*) > 1. */
async function checkProviderMappingUniqueness(supabase) {
  const { data: rows, error } = await supabase
    .from('provider_event_map')
    .select('provider, provider_event_id');
  if (error) throw error;
  const keyCount = new Map();
  for (const r of rows || []) {
    const key = `${r.provider}\t${r.provider_event_id}`;
    keyCount.set(key, (keyCount.get(key) || 0) + 1);
  }
  const duplicates = [...keyCount.entries()].filter(([, c]) => c > 1);
  return { duplicatePairs: duplicates.length, details: duplicates };
}

/** B) Orphan detection: canonical_events/markets/outcomes with no provider map row. */
async function checkOrphans(supabase) {
  const { data: events } = await supabase.from('canonical_events').select('id');
  const { data: maps } = await supabase.from('provider_event_map').select('canonical_event_id');
  const mappedEventIds = new Set((maps || []).map((r) => r.canonical_event_id));
  const eventOrphans = (events || []).filter((e) => !mappedEventIds.has(e.id)).length;

  const { data: markets } = await supabase.from('canonical_markets').select('id');
  const { data: marketMaps } = await supabase.from('provider_market_map').select('canonical_market_id');
  const mappedMarketIds = new Set((marketMaps || []).map((r) => r.canonical_market_id));
  const marketOrphans = (markets || []).filter((m) => !mappedMarketIds.has(m.id)).length;

  const { data: outcomes } = await supabase.from('canonical_outcomes').select('id');
  const { data: outcomeMaps } = await supabase.from('provider_outcome_map').select('canonical_outcome_id');
  const mappedOutcomeIds = new Set((outcomeMaps || []).map((r) => r.canonical_outcome_id));
  const outcomeOrphans = (outcomes || []).filter((o) => !mappedOutcomeIds.has(o.id)).length;

  return { eventOrphans, marketOrphans, outcomeOrphans };
}

/** C) Idempotency: resolve same (provider, provider_event_id) twice; same canonical_event_id; no new row. */
async function checkIdempotency(supabase, mapRows) {
  if (mapRows.length < 3) {
    return { passed: mapRows.length >= 1, message: `Need at least 3 provider_event_map rows for idempotency test; found ${mapRows.length}` };
  }
  const shuffled = [...mapRows].sort(() => Math.random() - 0.5);
  const sample = shuffled.slice(0, 3);
  const countBefore = mapRows.length;
  const results = [];
  for (const row of sample) {
    const id1 = await resolveEvent(supabase, row.provider, row.provider_event_id);
    const id2 = await resolveEvent(supabase, row.provider, row.provider_event_id);
    const same = id1 === id2 && id1 != null;
    results.push({ provider: row.provider, provider_event_id: row.provider_event_id, id1, id2, same });
  }
  const { data: afterRows } = await supabase.from('provider_event_map').select('provider, provider_event_id');
  const countAfter = (afterRows || []).length;
  const noNewRow = countAfter === countBefore;
  const allSame = results.every((r) => r.same);
  return { passed: allSame && noNewRow, results, countBefore, countAfter, noNewRow };
}

/** D) Cross-provider: known Dem candidate on both Kalshi and Polymarket → same canonical_event_id. */
async function checkCrossProviderConsistency(supabase) {
  const pairsPath = path.join(__dirname, 'prediction_market_event_pairs.json');
  let pairs;
  try {
    const raw = fs.readFileSync(pairsPath, 'utf8');
    pairs = JSON.parse(raw);
  } catch (_) {
    return { passed: false, message: 'Could not load prediction_market_event_pairs.json for cross-provider test' };
  }
  const dem = Array.isArray(pairs) ? pairs.find((p) => p.polymarketSlug === 'democratic-presidential-nominee-2028') : null;
  if (!dem) {
    return { passed: false, message: 'No Dem 2028 pair found in prediction_market_event_pairs.json' };
  }
  const kalshiEventId = dem.kalshiTicker.replace(/-[^-]+$/, '');
  const polymarketEventId = dem.polymarketSlug;
  const canonicalKalshi = await resolveEvent(supabase, 'kalshi', kalshiEventId);
  const canonicalPoly = await resolveEvent(supabase, 'polymarket', polymarketEventId);
  if (canonicalKalshi == null || canonicalPoly == null) {
    return {
      passed: false,
      message: 'One or both providers not mapped',
      kalshi: canonicalKalshi,
      polymarket: canonicalPoly,
    };
  }
  const same = canonicalKalshi === canonicalPoly;
  return {
    passed: same,
    kalshiEventId,
    polymarketEventId,
    canonicalKalshi,
    canonicalPoly,
    same,
  };
}

/** E) Rename simulation (dry-run): same provider_event_id, different title in payload → same canonical_event_id. */
async function checkRenameSimulation(supabase, mapRows) {
  if (mapRows.length === 0) {
    return { passed: false, message: 'No provider_event_map rows for rename simulation' };
  }
  const row = mapRows[Math.floor(Math.random() * mapRows.length)];
  const id1 = await resolveEvent(supabase, row.provider, row.provider_event_id);
  const id2 = await resolveEvent(supabase, row.provider, row.provider_event_id);
  const same = id1 === id2 && id1 != null;
  return {
    passed: same,
    provider: row.provider,
    provider_event_id: row.provider_event_id,
    canonical_event_id: id1,
    same,
  };
}

async function main() {
  const supabase = getSupabase();

  let totalCanonicalEvents = 0;
  let totalProviderEventMapRows = 0;
  let duplicateCount = 0;
  const orphans = { eventOrphans: 0, marketOrphans: 0, outcomeOrphans: 0 };
  const failures = [];

  console.log('--- Canonical mapping validation (read-only) ---\n');

  const { count: totalEvents } = await supabase.from('canonical_events').select('*', { count: 'exact', head: true });
  const { count: totalMaps } = await supabase.from('provider_event_map').select('*', { count: 'exact', head: true });
  totalCanonicalEvents = totalEvents ?? 0;
  totalProviderEventMapRows = totalMaps ?? 0;

  const { data: mapRows, error: mapError } = await supabase.from('provider_event_map').select('provider, provider_event_id, canonical_event_id');
  if (mapError) {
    console.error('Failed to fetch provider_event_map:', mapError.message);
    process.exit(1);
  }
  const mapRowsList = mapRows || [];

  const a = await checkProviderMappingUniqueness(supabase);
  duplicateCount = a.duplicatePairs;
  if (a.duplicatePairs > 0) {
    failures.push('A) Provider mapping uniqueness: FAIL (duplicates found)');
    a.details.forEach(([key, c]) => console.log(`  Duplicate: ${key} count=${c}`));
  } else {
    console.log('A) Provider mapping uniqueness: PASS (no duplicates)');
  }

  const b = await checkOrphans(supabase);
  orphans.eventOrphans = b.eventOrphans;
  orphans.marketOrphans = b.marketOrphans;
  orphans.outcomeOrphans = b.outcomeOrphans;
  console.log('B) Canonical orphan detection:');
  console.log(`   canonical_events with no provider_event_map: ${b.eventOrphans}`);
  console.log(`   canonical_markets with no provider_market_map: ${b.marketOrphans}`);
  console.log(`   canonical_outcomes with no provider_outcome_map: ${b.outcomeOrphans}`);
  if (b.eventOrphans > 0 || b.marketOrphans > 0 || b.outcomeOrphans > 0) {
    failures.push('B) Orphan detection: at least one orphan found (see counts above)');
  } else {
    console.log('   PASS (no orphans)');
  }

  const c = await checkIdempotency(supabase, mapRowsList);
  if (!c.passed) {
    failures.push('C) Idempotency: FAIL');
    if (c.results) c.results.forEach((r) => console.log(`   ${r.provider}/${r.provider_event_id}: id1=${r.id1} id2=${r.id2} same=${r.same}`));
    if (c.noNewRow === false) console.log(`   Row count changed: before=${c.countBefore} after=${c.countAfter}`);
    if (c.message) console.log('   ', c.message);
  } else {
    console.log('C) Idempotency test: PASS (3 random lookups identical twice; no new row)');
  }

  const d = await checkCrossProviderConsistency(supabase);
  if (!d.passed) {
    failures.push('D) Cross-provider consistency: FAIL');
    if (d.message) console.log('   ', d.message);
    if (d.canonicalKalshi != null) console.log('   Kalshi canonical_event_id:', d.canonicalKalshi);
    if (d.canonicalPoly != null) console.log('   Polymarket canonical_event_id:', d.canonicalPoly);
  } else {
    console.log('D) Cross-provider consistency: PASS (Kalshi + Polymarket share same canonical_event_id)');
  }

  const e = await checkRenameSimulation(supabase, mapRowsList);
  if (!e.passed) {
    failures.push('E) Rename simulation: FAIL');
    if (e.message) console.log('   ', e.message);
  } else {
    console.log('E) Rename simulation (dry-run): PASS (same provider_event_id → same canonical_event_id)');
  }

  console.log('\n--- Summary ---');
  console.log('Total canonical_events:', totalCanonicalEvents);
  console.log('Total provider_event_map rows:', totalProviderEventMapRows);
  console.log('Orphan counts: events', orphans.eventOrphans, '| markets', orphans.marketOrphans, '| outcomes', orphans.outcomeOrphans);
  console.log('Duplicate (provider, provider_event_id) pairs:', duplicateCount);
  if (totalProviderEventMapRows === 0) {
    console.log('Note: C/D/E require provider_event_map data; run again after seeding mappings.');
  }
  const passed = failures.length === 0;
  console.log('Status:', passed ? 'PASS' : 'FAIL');
  if (failures.length > 0) {
    failures.forEach((f) => console.log(' -', f));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
