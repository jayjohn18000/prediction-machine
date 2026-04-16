#!/usr/bin/env node
/**
 * PMCI auto-acceptor — Phase E2.
 *
 * Queries pmci.proposed_links for rows with decision IS NULL in the configured
 * categories (default: crypto, economics), then accepts each proposal that
 * passes all rules by POSTing to /v1/review/decision.
 *
 * Rules (all must hold):
 *   - confidence >= PMCI_AUTO_ACCEPT_MIN_CONFIDENCE (default 0.70)
 *   - decision IS NULL (not already rejected/accepted)
 *   - category in PMCI_AUTO_ACCEPT_CATEGORIES (default "crypto,economics")
 *   - no existing non-removed market_links row for either provider_market_id
 *     (dedup guard against already-linked markets)
 *   - proposed_relationship_type = 'equivalent' (no auto-accept of proxy)
 *
 * Env:
 *   DATABASE_URL, PMCI_API_KEY required
 *   API_BASE_URL (default http://localhost:8787)
 *   PMCI_AUTO_ACCEPT_MIN_CONFIDENCE (default 0.70)
 *   PMCI_AUTO_ACCEPT_CATEGORIES (default "crypto,economics")
 *
 * Exit codes:
 *   0 = ran cleanly (may have zero accepts)
 *   1 = fatal error (DB down, API unreachable, bad config)
 */

import pg from 'pg';
import { loadEnv } from '../../src/platform/env.mjs';

const { Client } = pg;
loadEnv();

const BASE = (process.env.API_BASE_URL || 'https://pmci-api.fly.dev').replace(/\/$/, '');
const MIN_CONF = Number(process.env.PMCI_AUTO_ACCEPT_MIN_CONFIDENCE ?? 0.70);
const CATEGORIES = (process.env.PMCI_AUTO_ACCEPT_CATEGORIES || 'crypto,economics')
  .split(',')
  .map((c) => c.trim())
  .filter(Boolean);

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
    `auto-accept: config min_confidence=${MIN_CONF} categories=${CATEGORIES.join(',')} base=${BASE}`,
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
  } finally {
    await client.end();
  }

  console.log(`auto-accept: found ${candidates.length} candidate proposal(s)`);

  let accepted = 0;
  let skipped = 0;
  let flagged = 0;

  for (const row of candidates) {
    const reason = await checkRules(row);
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

  console.log(`auto-accept: done accepted=${accepted} skipped=${skipped} flagged=${flagged}`);
}

async function checkRules(row) {
  if (row.confidence === null || Number(row.confidence) < MIN_CONF) {
    return `confidence_below_threshold(${row.confidence})`;
  }
  if (row.proposed_relationship_type !== 'equivalent') {
    return `relationship_type=${row.proposed_relationship_type}_not_equivalent`;
  }
  // Dedup guard: fail if either provider_market_id already has a non-removed market_links row
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
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
  } finally {
    await client.end();
  }
  return null;
}

async function submitAccept(proposedId, relationshipType) {
  const url = `${BASE}/v1/review/decision`;
  // pg returns bigint as string; Fastify/zod expects number. Coerce.
  const numericId = typeof proposedId === 'string' ? Number(proposedId) : proposedId;
  const body = {
    proposed_id: numericId,
    decision: 'accept',
    relationship_type: relationshipType || 'equivalent',
    note: 'auto-accepted by pmci-auto-accept.mjs',
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
