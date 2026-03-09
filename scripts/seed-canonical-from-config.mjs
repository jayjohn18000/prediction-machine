#!/usr/bin/env node
/**
 * Seed canonical_events, canonical_markets, canonical_outcomes and
 * provider_event_map, provider_market_map, provider_outcome_map from
 * scripts/prediction_market_event_pairs.json.
 *
 * Idempotent: uses provider_*_map as first lookup; does not create
 * new canonical rows when mapping already exists.
 *
 * Does NOT modify: edge_windows, execution_signal, routing, scoring.
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

/** Base Kalshi event ticker (strip last segment). */
function kalshiBaseEventTicker(kalshiTicker) {
  return kalshiTicker.replace(/-[^-]+$/, '');
}

/** Resolve canonical_event_id from provider_event_map; return null if not found. */
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

/** Resolve canonical_market_id from provider_market_map; return null if not found. */
async function resolveMarket(supabase, provider, providerMarketId) {
  const { data, error } = await supabase
    .from('provider_market_map')
    .select('canonical_market_id')
    .eq('provider', provider)
    .eq('provider_market_id', providerMarketId)
    .maybeSingle();
  if (error) throw error;
  return data?.canonical_market_id ?? null;
}

/** Resolve canonical_outcome_id from provider_outcome_map; return null if not found. */
async function resolveOutcome(supabase, provider, providerOutcomeId) {
  const { data, error } = await supabase
    .from('provider_outcome_map')
    .select('canonical_outcome_id')
    .eq('provider', provider)
    .eq('provider_outcome_id', providerOutcomeId)
    .maybeSingle();
  if (error) throw error;
  return data?.canonical_outcome_id ?? null;
}

async function main() {
  const supabase = getSupabase();
  const configPath = path.join(__dirname, 'prediction_market_event_pairs.json');
  let pairs;
  try {
    pairs = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    console.error('Error loading config:', err.message);
    process.exit(1);
  }
  if (!Array.isArray(pairs) || pairs.length === 0) {
    console.error('Config must be a non-empty array of { eventName, kalshiTicker, polymarketSlug, polymarketOutcomeName }');
    process.exit(1);
  }

  const stats = {
    canonical_events_created: 0,
    canonical_markets_created: 0,
    canonical_outcomes_created: 0,
    provider_event_maps_inserted: 0,
    provider_market_maps_inserted: 0,
    provider_outcome_maps_inserted: 0,
    skipped_existing_event: 0,
    skipped_existing_market: 0,
    skipped_existing_outcome: 0,
  };

  const uniqueEvents = new Map();
  for (const p of pairs) {
    const base = kalshiBaseEventTicker(p.kalshiTicker);
    const key = `${base}\t${p.polymarketSlug}`;
    if (!uniqueEvents.has(key)) uniqueEvents.set(key, { kalshiBase: base, polymarketSlug: p.polymarketSlug });
  }

  const eventIdByKey = new Map();
  const eventMapRows = [];

  for (const { kalshiBase, polymarketSlug } of uniqueEvents.values()) {
    let canonicalEventId = await resolveEvent(supabase, 'kalshi', kalshiBase)
      ?? await resolveEvent(supabase, 'polymarket', polymarketSlug);
    if (canonicalEventId == null) {
      const { data: inserted, error: insertErr } = await supabase
        .from('canonical_events')
        .insert({ title: polymarketSlug, category: 'politics', region: 'US' })
        .select('id')
        .single();
      if (insertErr) throw insertErr;
      canonicalEventId = inserted.id;
      stats.canonical_events_created += 1;
    } else {
      stats.skipped_existing_event += 1;
    }
    eventIdByKey.set(`${kalshiBase}\t${polymarketSlug}`, canonicalEventId);
    eventMapRows.push(
      { provider: 'kalshi', provider_event_id: kalshiBase, canonical_event_id: canonicalEventId },
      { provider: 'polymarket', provider_event_id: polymarketSlug, canonical_event_id: canonicalEventId }
    );
  }

  if (eventMapRows.length > 0) {
    const { error: eErr } = await supabase.from('provider_event_map').upsert(eventMapRows, { onConflict: 'provider,provider_event_id' });
    if (eErr) throw eErr;
    stats.provider_event_maps_inserted = eventMapRows.length;
  }

  for (const p of pairs) {
    const kalshiBase = kalshiBaseEventTicker(p.kalshiTicker);
    const canonicalEventId = eventIdByKey.get(`${kalshiBase}\t${p.polymarketSlug}`);
    if (canonicalEventId == null) {
      console.warn('Missing canonical event for', kalshiBase, p.polymarketSlug, '; skipping pair', p.kalshiTicker);
      continue;
    }

    const pmMarketId = `${p.polymarketSlug}:${p.polymarketOutcomeName}`;
    let canonicalMarketId = await resolveMarket(supabase, 'kalshi', p.kalshiTicker)
      ?? await resolveMarket(supabase, 'polymarket', pmMarketId);
    if (canonicalMarketId == null) {
      const { data: inserted, error: insertErr } = await supabase
        .from('canonical_markets')
        .insert({ title: p.eventName, canonical_event_id: canonicalEventId })
        .select('id')
        .single();
      if (insertErr) throw insertErr;
      canonicalMarketId = inserted.id;
      stats.canonical_markets_created += 1;
    } else {
      stats.skipped_existing_market += 1;
    }
    const { error: m1 } = await supabase.from('provider_market_map').upsert(
      [{ provider: 'kalshi', provider_market_id: p.kalshiTicker, canonical_market_id: canonicalMarketId }],
      { onConflict: 'provider,provider_market_id' }
    );
    if (m1) throw m1;
    stats.provider_market_maps_inserted += 2;
    const { error: m2 } = await supabase.from('provider_market_map').upsert(
      [{ provider: 'polymarket', provider_market_id: pmMarketId, canonical_market_id: canonicalMarketId }],
      { onConflict: 'provider,provider_market_id' }
    );
    if (m2) throw m2;

    const kalshiOutcomeId = `${p.kalshiTicker}:YES`;
    const pmOutcomeId = `${p.polymarketSlug}:${p.polymarketOutcomeName}:YES`;
    let canonicalOutcomeId = await resolveOutcome(supabase, 'kalshi', kalshiOutcomeId)
      ?? await resolveOutcome(supabase, 'polymarket', pmOutcomeId);
    if (canonicalOutcomeId == null) {
      const { data: inserted, error: insertErr } = await supabase
        .from('canonical_outcomes')
        .insert({ name: p.polymarketOutcomeName, canonical_market_id: canonicalMarketId })
        .select('id')
        .single();
      if (insertErr) throw insertErr;
      canonicalOutcomeId = inserted.id;
      stats.canonical_outcomes_created += 1;
    } else {
      stats.skipped_existing_outcome += 1;
    }
    const { error: o1 } = await supabase.from('provider_outcome_map').upsert(
      [{ provider: 'kalshi', provider_outcome_id: kalshiOutcomeId, canonical_outcome_id: canonicalOutcomeId }],
      { onConflict: 'provider,provider_outcome_id' }
    );
    if (o1) throw o1;
    stats.provider_outcome_maps_inserted += 2;
    const { error: o2 } = await supabase.from('provider_outcome_map').upsert(
      [{ provider: 'polymarket', provider_outcome_id: pmOutcomeId, canonical_outcome_id: canonicalOutcomeId }],
      { onConflict: 'provider,provider_outcome_id' }
    );
    if (o2) throw o2;
  }

  const totalMaps = stats.provider_event_maps_inserted + stats.provider_market_maps_inserted + stats.provider_outcome_maps_inserted;
  const totalSkipped = stats.skipped_existing_event + stats.skipped_existing_market + stats.skipped_existing_outcome;

  console.log('--- Seed summary ---');
  console.log('canonical_events created:', stats.canonical_events_created);
  console.log('canonical_markets created:', stats.canonical_markets_created);
  console.log('canonical_outcomes created:', stats.canonical_outcomes_created);
  console.log('provider maps inserted:', totalMaps);
  console.log('skipped existing:', totalSkipped);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
