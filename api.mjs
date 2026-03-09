#!/usr/bin/env node
/**
 * Execution intelligence API — read-only endpoints for ranked execution signals.
 *
 * @deprecated Legacy Node HTTP server. The active PMCI HTTP API is src/api.mjs (Fastify).
 *   Use `npm run api:pmci` to run the PMCI API. This file remains for execution-signal/routing
 *   endpoints only; sunset milestone TBD. See docs/system-state.md and docs/decision-log.md.
 *
 * GET /signals/top — top 20 execution signals from execution_signal_quality (by execution_score DESC).
 * GET /execution-decision?candidate={candidate} — decision-ready intelligence from execution_signal_calibrated (percentile-based).
 * GET /routing-decisions/top?min_confidence=&limit= — top rows from execution_signal_calibrated by score_percentile (filter score_percentile >= min_confidence).
 *
 * Env: SUPABASE_URL, SUPABASE_ANON_KEY (or SUPABASE_SERVICE_ROLE_KEY).
 * Optional: DATABASE_URL — when set, /signals/top, /execution-decision, and /routing-decisions/top use direct SQL (avoids PostgREST schema cache issues).
 */

import { createClient } from '@supabase/supabase-js';
import http from 'node:http';
import pg from 'pg';
import { loadEnv } from './src/platform/env.mjs';

const { Client } = pg;
loadEnv();

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY (or SUPABASE_SERVICE_ROLE_KEY) are required');
  }
  return createClient(url, key);
}

function getPgClient() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || !databaseUrl.trim()) return null;
  const client = new Client({ connectionString: databaseUrl.trim() });
  return client;
}

const TOP_SIGNALS_LIMIT = 20;
const FIELDS = 'candidate,event_id,execution_score,avg_edge,avg_duration_seconds,events_per_hour,last_seen';
const DECISION_FIELDS =
  'candidate,event_id,execution_score,avg_edge,avg_duration_seconds,events_per_hour,last_seen,score_percentile,execute_default';

const SQL_TOP_SIGNALS = `
  SELECT candidate, event_id, execution_score, avg_edge, avg_duration_seconds, events_per_hour, last_seen
  FROM public.execution_signal_quality
  ORDER BY execution_score DESC
  LIMIT $1
`;
const SQL_EXECUTION_DECISION = `
  SELECT candidate, event_id, execution_score, avg_edge, avg_duration_seconds, events_per_hour, last_seen, score_percentile, execute_default
  FROM public.execution_signal_calibrated
  WHERE candidate = $1
  ORDER BY last_seen DESC
  LIMIT 1
`;
const ROUTING_TOP_FIELDS =
  'candidate,event_id,avg_edge,avg_duration_seconds,events_per_hour,score_percentile,execute_default,last_seen';
const SQL_ROUTING_TOP = `
  SELECT candidate, event_id, avg_edge, avg_duration_seconds, events_per_hour, score_percentile, execute_default, last_seen
  FROM public.execution_signal_calibrated
  WHERE score_percentile >= $1
  ORDER BY score_percentile DESC
  LIMIT $2
`;

async function fetchTopSignals(supabase, pgClient) {
  if (pgClient) {
    const res = await pgClient.query(SQL_TOP_SIGNALS, [TOP_SIGNALS_LIMIT]);
    return res.rows ?? [];
  }
  const { data, error } = await supabase
    .from('execution_signal_quality')
    .select(FIELDS)
    .order('execution_score', { ascending: false })
    .limit(TOP_SIGNALS_LIMIT);
  if (error) throw error;
  return data ?? [];
}

async function fetchExecutionDecision(supabase, pgClient, candidate) {
  if (pgClient) {
    const res = await pgClient.query(SQL_EXECUTION_DECISION, [candidate]);
    const row = res.rows?.[0] ?? null;
    return row;
  }
  const { data, error } = await supabase
    .from('execution_signal_calibrated')
    .select(DECISION_FIELDS)
    .eq('candidate', candidate)
    .order('last_seen', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

const DEFAULT_MIN_CONFIDENCE = 0.8;
const DEFAULT_ROUTING_LIMIT = 20;

async function fetchRoutingDecisionsTop(supabase, pgClient, minConfidence, limit) {
  if (pgClient) {
    const res = await pgClient.query(SQL_ROUTING_TOP, [minConfidence, limit]);
    return res.rows ?? [];
  }
  const { data, error } = await supabase
    .from('execution_signal_calibrated')
    .select(ROUTING_TOP_FIELDS)
    .gte('score_percentile', minConfidence)
    .order('score_percentile', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

function buildDecisionPayload(row) {
  const score_percentile = row?.score_percentile ?? null;
  const confidence_score = score_percentile !== null ? Number(Number(score_percentile).toFixed(4)) : null;
  const execute = row?.execute_default ?? false;
  return {
    candidate: row?.candidate ?? null,
    event_id: row?.event_id ?? null,
    execution_score: row?.execution_score ?? null,
    avg_edge: row?.avg_edge ?? null,
    avg_duration_seconds: row?.avg_duration_seconds ?? null,
    events_per_hour: row?.events_per_hour ?? null,
    last_seen: row?.last_seen ?? null,
    score_percentile: score_percentile !== null ? Number(Number(score_percentile).toFixed(4)) : null,
    confidence_score,
    execute,
  };
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const PORT = Number(process.env.PORT) || 3000;
const supabase = getSupabase();
let pgClient = getPgClient();

async function ensurePg() {
  if (!pgClient) return null;
  try {
    await pgClient.connect();
    console.log('Using DATABASE_URL for /signals/top, /execution-decision, and /routing-decisions/top (direct SQL).');
    return pgClient;
  } catch (err) {
    console.warn('DATABASE_URL connect failed, using Supabase only:', err.message);
    pgClient = null;
    return null;
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;
  const client = pgClient;

  if (pathname === '/signals/top') {
    try {
      const signals = await fetchTopSignals(supabase, client);
      sendJson(res, 200, signals);
    } catch (err) {
      console.error('GET /signals/top error:', err.message);
      sendJson(res, 500, { error: 'Failed to fetch signals' });
    }
    return;
  }

  if (pathname === '/execution-decision') {
    const candidate = url.searchParams.get('candidate');
    if (!candidate || !candidate.trim()) {
      sendJson(res, 400, { error: 'Missing or empty query parameter: candidate' });
      return;
    }
    try {
      const row = await fetchExecutionDecision(supabase, client, candidate.trim());
      const payload = buildDecisionPayload(row);
      if (row === null) {
        sendJson(res, 404, { ...payload, error: 'No execution signal found for candidate' });
        return;
      }
      sendJson(res, 200, payload);
    } catch (err) {
      console.error('GET /execution-decision error:', err.message);
      sendJson(res, 500, { error: 'Failed to fetch execution decision' });
    }
    return;
  }

  if (pathname === '/routing-decisions/top') {
    const minConfidence = Math.max(0, Math.min(1, Number(url.searchParams.get('min_confidence')) || DEFAULT_MIN_CONFIDENCE));
    const limitParam = Number(url.searchParams.get('limit'));
    const limit = Number.isInteger(limitParam) && limitParam > 0 ? Math.min(limitParam, 1000) : DEFAULT_ROUTING_LIMIT;
    try {
      const rows = await fetchRoutingDecisionsTop(supabase, client, minConfidence, limit);
      sendJson(res, 200, rows);
    } catch (err) {
      console.error('GET /routing-decisions/top error:', err.message);
      sendJson(res, 500, { error: 'Failed to fetch routing decisions' });
    }
    return;
  }

  sendJson(res, 404, { error: 'Not Found' });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Free it with: lsof -ti :${PORT} | xargs kill -9`);
  } else {
    console.error('Server error:', err.message);
  }
  process.exit(1);
});

ensurePg().then(() => {
  server.listen(PORT, () => {
    console.log(`API listening on http://localhost:${PORT}`);
  });
});
