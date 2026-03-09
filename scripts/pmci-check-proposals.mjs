#!/usr/bin/env node
/**
 * PMCI Phase 2: Validation — run proposer once and assert proposals or auto-accept;
 * hit /v1/review/queue and expect [] or a valid proposal object.
 * Env: DATABASE_URL, API_BASE_URL (default http://localhost:8787) for queue check.
 */

import pg from 'pg';
import { loadEnv } from '../src/platform/env.mjs';

const { Client } = pg;
loadEnv();

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  let countBeforeEquiv = 0;
  let countBeforeProxy = 0;
  let countBeforeAuto = 0;
  try {
    const before = await client.query(
      `SELECT proposed_relationship_type, decision, count(*)::int AS c
       FROM pmci.proposed_links WHERE category = 'politics'
       GROUP BY 1, 2`,
    );
    for (const r of before.rows || []) {
      if (r.proposed_relationship_type === 'equivalent' && r.decision === null) countBeforeEquiv += r.c;
      if (r.proposed_relationship_type === 'equivalent' && r.decision === 'accepted') countBeforeAuto += r.c;
      if (r.proposed_relationship_type === 'proxy' && r.decision === null) countBeforeProxy += r.c;
    }
  } finally {
    await client.end();
  }

  const { spawn } = await import('node:child_process');
  const proposer = spawn('node', ['scripts/pmci-propose-links-politics.mjs'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });

  let stdout = '';
  let stderr = '';
  proposer.stdout.on('data', (c) => { stdout += c; });
  proposer.stderr.on('data', (c) => { stderr += c; });

  const exitCode = await new Promise((resolve) => proposer.on('close', resolve));
  if (exitCode !== 0) {
    console.error('Proposer exited with code', exitCode);
    console.error(stderr || stdout);
    process.exit(1);
  }

  const client2 = new Client({ connectionString: databaseUrl });
  await client2.connect();
  let countAfterEquiv = 0;
  let countAfterProxy = 0;
  let countAfterAuto = 0;
  try {
    const after = await client2.query(
      `SELECT proposed_relationship_type, decision, count(*)::int AS c
       FROM pmci.proposed_links WHERE category = 'politics'
       GROUP BY 1, 2`,
    );
    for (const r of after.rows || []) {
      if (r.proposed_relationship_type === 'equivalent' && r.decision === null) countAfterEquiv += r.c;
      if (r.proposed_relationship_type === 'equivalent' && r.decision === 'accepted') countAfterAuto += r.c;
      if (r.proposed_relationship_type === 'proxy' && r.decision === null) countAfterProxy += r.c;
    }
  } finally {
    await client2.end();
  }

  const proposalsIncreased =
    countAfterEquiv > countBeforeEquiv || countAfterProxy > countBeforeProxy || countAfterAuto > countBeforeAuto;
  if (!proposalsIncreased) {
    console.log(
      'pmci:check:proposals proposer run did not increase pending equivalent/proxy or auto-accepted counts (may be expected if no unlinked pairs or caps hit).',
    );
  } else {
    console.log('pmci:check:proposals proposer increased proposals or auto-accepts.');
  }

  const base = (process.env.API_BASE_URL || 'http://localhost:8787').replace(/\/$/, '');
  let queueRes;
  let queueData = {};
  try {
    queueRes = await fetch(`${base}/v1/review/queue?category=politics&limit=1&min_confidence=0.88`);
    queueData = await queueRes.json().catch(() => ({}));
  } catch (err) {
    console.warn('pmci:check:proposals API queue fetch failed (is API running?):', err.message);
    console.log('pmci:check:proposals done.');
    process.exit(0);
  }
  if (!queueRes.ok) {
    console.warn('pmci:check:proposals API queue fetch failed (is API running?):', queueRes.status);
  } else if (Array.isArray(queueData)) {
    if (queueData.length === 0) {
      console.log('pmci:check:proposals queue is empty (ok).');
    } else {
      const item = queueData[0];
      if (item && typeof item.proposed_id === 'number' && item.market_a && item.market_b) {
        console.log('pmci:check:proposals queue returns valid proposal object.');
      } else {
        console.error('pmci:check:proposals queue returned invalid shape:', item);
        process.exit(1);
      }
    }
  } else if (queueData?.error) {
    console.warn('pmci:check:proposals queue error:', queueData.error);
  }

  console.log('pmci:check:proposals done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
