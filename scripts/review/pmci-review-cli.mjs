#!/usr/bin/env node
/**
 * PMCI Phase 2: Fetch one review queue item and submit accept/reject/skip.
 * Usage:
 *   node scripts/pmci-review-cli.mjs [--accept|--reject|--skip] [--note "optional note"]
 *   If no flag: fetch and print; with --accept/--reject/--skip: submit decision.
 * Env: API_BASE_URL (default http://localhost:8787)
 */

import { loadEnv } from '../../src/platform/env.mjs';
loadEnv();

const BASE = (process.env.API_BASE_URL || 'http://localhost:8787').replace(/\/$/, '');

async function fetchQueue(limit = 1, minConfidence = 0.87) {
  const url = `${BASE}/v1/review/queue?category=politics&limit=${limit}&min_confidence=${minConfidence}`;
  const res = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(process.env.PMCI_API_KEY ? { "x-pmci-api-key": process.env.PMCI_API_KEY } : {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Queue fetch failed:', res.status, data);
    process.exit(1);
  }
  return Array.isArray(data) ? data : [];
}

async function submitDecision(proposedId, decision, relationshipType, note) {
  const url = `${BASE}/v1/review/decision`;
  const body = {
    proposed_id: proposedId,
    decision,
    relationship_type: relationshipType,
    ...(note ? { note } : {}),
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.PMCI_API_KEY ? { 'x-pmci-api-key': process.env.PMCI_API_KEY } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Decision submit failed:', res.status, data);
    process.exit(1);
  }
  return data;
}

function printItem(item) {
  console.log('--- Proposal', item.proposed_id, '---');
  console.log('Type:', item.proposed_relationship_type, '| Confidence:', item.confidence);
  console.log('Reasons:', JSON.stringify(item.reasons, null, 2));
  console.log('Market A:', item.market_a?.provider, item.market_a?.provider_market_ref);
  console.log('  Title:', item.market_a?.title);
  if (item.market_a?.latest_snapshot) {
    console.log('  Price:', item.market_a.latest_snapshot.price_yes, '| Observed:', item.market_a.latest_snapshot.observed_at, '| Source:', item.market_a.latest_snapshot.price_source);
  }
  console.log('Market B:', item.market_b?.provider, item.market_b?.provider_market_ref);
  console.log('  Title:', item.market_b?.title);
  if (item.market_b?.latest_snapshot) {
    console.log('  Price:', item.market_b.latest_snapshot.price_yes, '| Observed:', item.market_b.latest_snapshot.observed_at, '| Source:', item.market_b.latest_snapshot.price_source);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const accept = args.includes('--accept');
  const reject = args.includes('--reject');
  const skip = args.includes('--skip');
  const noteIdx = args.indexOf('--note');
  const note = noteIdx >= 0 && args[noteIdx + 1] ? args[noteIdx + 1] : undefined;

  const queue = await fetchQueue(1);
  if (queue.length === 0) {
    console.log('No pending proposals in queue.');
    process.exit(0);
  }

  const item = queue[0];
  printItem(item);

  if (accept) {
    const result = await submitDecision(item.proposed_id, 'accept', item.proposed_relationship_type, note);
    console.log('Submitted accept:', result);
  } else if (reject) {
    const result = await submitDecision(item.proposed_id, 'reject', item.proposed_relationship_type, note);
    console.log('Submitted reject:', result);
  } else if (skip) {
    const result = await submitDecision(item.proposed_id, 'skip', item.proposed_relationship_type, note);
    console.log('Submitted skip:', result);
  } else {
    console.log('To decide: run with --accept, --reject, or --skip (optional --note "text")');
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
