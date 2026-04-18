#!/usr/bin/env node
/**
 * PMCI auto-acceptor — Phase E2 (strict tier).
 *
 * Tier: auto-accept only when confidence >= PMCI_AUTO_ACCEPT_STRICT_MIN (default 0.75)
 * and category-specific gates (crypto: strike_match + template date alignment;
 * economics: event_group + meeting_date alignment). All other pending rows are left
 * for POST /v1/review/batch or manual review.
 *
 * Env:
 *   DATABASE_URL, PMCI_API_KEY required
 *   API_BASE_URL (default https://pmci-api.fly.dev)
 *   PMCI_AUTO_ACCEPT_STRICT_MIN (default 0.75)
 *   PMCI_AUTO_ACCEPT_CATEGORIES (default "crypto,economics")
 */

import pg from 'pg';
import { loadEnv } from '../../src/platform/env.mjs';

const { Client } = pg;
loadEnv();

const BASE = (process.env.API_BASE_URL || 'https://pmci-api.fly.dev').replace(/\/$/, '');
const STRICT_MIN = Number(process.env.PMCI_AUTO_ACCEPT_STRICT_MIN ?? 0.75);
const CATEGORIES = (process.env.PMCI_AUTO_ACCEPT_CATEGORIES || 'crypto,economics')
  .split(',')
  .map((c) => c.trim())
  .filter(Boolean);

function isoDateFromTemplateParams(tp) {
  if (!tp || typeof tp !== 'object') return null;
  const raw = tp.deadline || tp.date || tp.datetime_start || tp.meeting_date;
  if (typeof raw !== 'string') return null;
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function cryptoDatesAligned(ma, mb) {
  const da = isoDateFromTemplateParams(ma.template_params);
  const db = isoDateFromTemplateParams(mb.template_params);
  if (da && db) return da === db;
  if (ma.close_time && mb.close_time) {
    const a = new Date(ma.close_time).toISOString().slice(0, 10);
    const b = new Date(mb.close_time).toISOString().slice(0, 10);
    return a === b;
  }
  return false;
}

function economicsMeetingsAligned(ma, mb) {
  const pa = ma.template_params || {};
  const pb = mb.template_params || {};
  const a = pa.meeting_date ?? pa.meeting;
  const b = pb.meeting_date ?? pb.meeting;
  if (a != null && b != null) return String(a).trim() === String(b).trim();
  if (ma.close_time && mb.close_time) {
    const da = new Date(ma.close_time).toISOString().slice(0, 10);
    const db = new Date(mb.close_time).toISOString().slice(0, 10);
    return da === db;
  }
  return false;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error('auto-accept: DATABASE_URL is required');
    process.exit(1);
  }
  if (!process.env.PMCI_API_KEY) {
    console.error('auto-accept: PMCI_API_KEY is required');
    process.exit(1);
  }

  console.log(
    `auto-accept: config strict_min=${STRICT_MIN} categories=${CATEGORIES.join(',')} base=${BASE}`,
  );

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  let candidates;
  try {
    const res = await client.query(
      `SELECT id, category, provider_market_id_a, provider_market_id_b,
              proposed_relationship_type, confidence, reasons
         FROM pmci.proposed_links
        WHERE decision IS NULL
          AND category = ANY($1::text[])
        ORDER BY confidence DESC, id ASC`,
      [CATEGORIES],
    );
    candidates = res.rows;
  } catch (e) {
    await client.end();
    throw e;
  }

  console.log(`auto-accept: found ${candidates.length} candidate proposal(s)`);

  let accepted = 0;
  let skipped = 0;
  let flagged = 0;

  for (const row of candidates) {
    const reason = await checkRules(client, row);
    if (reason) {
      skipped += 1;
      console.log(
        `auto-accept: skip proposed_id=${row.id} category=${row.category} confidence=${row.confidence} reason=${reason}`,
      );
      continue;
    }

    try {
      const result = await submitAccept(row.id, row.proposed_relationship_type);
      if (result.error) {
        flagged += 1;
        console.log(
          `auto-accept: FLAG proposed_id=${row.id} category=${row.category} api_error=${JSON.stringify(result.error)}`,
        );
        continue;
      }
      accepted += 1;
      console.log(
        `auto-accept: accept proposed_id=${row.id} category=${row.category} confidence=${row.confidence} family_id=${result.family_id ?? 'n/a'}`,
      );
    } catch (err) {
      flagged += 1;
      console.log(
        `auto-accept: FLAG proposed_id=${row.id} category=${row.category} error=${err.message}`,
      );
    }
  }

  await client.end();

  console.log(`auto-accept: done accepted=${accepted} skipped=${skipped} flagged=${flagged}`);
}

async function checkRules(client, row) {
  if (row.confidence === null || Number(row.confidence) < STRICT_MIN) {
    return `below_strict_threshold(${row.confidence}, need >= ${STRICT_MIN})`;
  }
  if (row.proposed_relationship_type !== 'equivalent') {
    return `relationship_type=${row.proposed_relationship_type}_not_equivalent`;
  }

  const reasons = row.reasons ?? {};
  const cat = String(row.category || '').trim();

  const guard = await client.query(
    `SELECT provider_market_id
       FROM pmci.market_links
      WHERE status <> 'removed'
        AND provider_market_id = ANY($1::bigint[])
      LIMIT 1`,
    [[row.provider_market_id_a, row.provider_market_id_b]],
  );
  if (guard.rows.length > 0) {
    return `already_linked_provider_market_id=${guard.rows[0].provider_market_id}`;
  }

  const mres = await client.query(
    `SELECT id, template_params, close_time
       FROM pmci.provider_markets
      WHERE id IN ($1, $2)`,
    [row.provider_market_id_a, row.provider_market_id_b],
  );
  const byId = new Map(mres.rows.map((r) => [Number(r.id), r]));
  const ma = byId.get(Number(row.provider_market_id_a));
  const mb = byId.get(Number(row.provider_market_id_b));
  if (!ma || !mb) return 'market_row_missing';

  if (cat === 'crypto') {
    if (reasons.proposal_type !== 'strike_match') {
      return `crypto_requires_strike_match(got ${reasons.proposal_type || 'none'})`;
    }
    if (!cryptoDatesAligned(ma, mb)) {
      return 'crypto_date_alignment_failed';
    }
    return null;
  }

  if (cat === 'economics') {
    if (reasons.proposal_type !== 'event_group') {
      return `economics_requires_event_group(got ${reasons.proposal_type || 'none'})`;
    }
    if (!economicsMeetingsAligned(ma, mb)) {
      return 'economics_meeting_alignment_failed';
    }
    return null;
  }

  return `category_not_auto_accepted(${cat})`;
}

async function submitAccept(proposedId, relationshipType) {
  const url = `${BASE}/v1/review/decision`;
  const numericId = typeof proposedId === 'string' ? Number(proposedId) : proposedId;
  const body = {
    proposed_id: numericId,
    decision: 'accept',
    relationship_type: relationshipType || 'equivalent',
    note: 'auto-accepted by pmci-auto-accept.mjs (strict tier)',
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-pmci-api-key': process.env.PMCI_API_KEY,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { error: { status: res.status, body: data } };
  }
  return data;
}

main().catch((err) => {
  console.error('auto-accept: fatal', err);
  process.exit(1);
});
