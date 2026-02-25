#!/usr/bin/env node
/**
 * Backtest: Naive vs Filtered routing (all events).
 * Loads all (candidate, event_id) from execution_signal_calibrated; evaluates edge_windows
 * across all events. Compares execute-on-every-window vs score_percentile threshold.
 * Outputs global summary and per-event breakdown. Read-only; no schema changes.
 */

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const { Client } = pg;

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

const SQL_NAIVE = `
  SELECT
    COUNT(*)::integer AS total_trades,
    AVG(avg_edge)::double precision AS avg_edge,
    AVG(duration_seconds)::double precision AS avg_duration_seconds,
    SUM(avg_edge)::double precision AS total_edge_sum,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_seconds)::double precision AS median_duration
  FROM public.edge_windows
`;
const SQL_FILTERED = `
  SELECT
    COUNT(*)::integer AS total_trades,
    AVG(w.avg_edge)::double precision AS avg_edge,
    AVG(w.duration_seconds)::double precision AS avg_duration_seconds,
    SUM(w.avg_edge)::double precision AS total_edge_sum,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY w.duration_seconds)::double precision AS median_duration
  FROM public.edge_windows w
  JOIN public.execution_signal_calibrated s
    ON w.candidate = s.candidate
   AND w.event_id = s.event_id
  WHERE s.score_percentile >= $1
`;
const SQL_CALIBRATED_ALL = `
  SELECT candidate, event_id, score_percentile, avg_duration_seconds
  FROM public.execution_signal_calibrated
`;
const SQL_STABILITY_FILTERED = `
  SELECT
    COUNT(*)::integer AS total_trades,
    AVG(w.avg_edge)::double precision AS avg_edge,
    AVG(w.duration_seconds)::double precision AS avg_duration_seconds,
    SUM(w.avg_edge)::double precision AS total_edge_sum,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY w.duration_seconds)::double precision AS median_duration
  FROM public.edge_windows w
  WHERE (w.candidate, w.event_id) IN (
    SELECT * FROM unnest($1::text[], $2::text[]) AS t(c, e)
  )
`;
const SQL_MIN_DURATION_FILTERED = `
  SELECT
    COUNT(*)::integer AS total_trades,
    AVG(w.avg_edge)::double precision AS avg_edge,
    AVG(w.duration_seconds)::double precision AS avg_duration_seconds,
    SUM(w.avg_edge)::double precision AS total_edge_sum,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY w.duration_seconds)::double precision AS median_duration
  FROM public.edge_windows w
  JOIN public.execution_signal_calibrated s
    ON w.candidate = s.candidate
   AND w.event_id = s.event_id
  WHERE w.duration_seconds >= $1
    AND s.score_percentile >= $2
`;

const SQL_EDGE_WINDOWS_PAIRS = `
  SELECT DISTINCT candidate, event_id FROM public.edge_windows
`;
const SQL_NAIVE_PER_EVENT = `
  SELECT
    event_id,
    COUNT(*)::integer AS total_trades,
    AVG(avg_edge)::double precision AS avg_edge,
    AVG(duration_seconds)::double precision AS avg_duration_seconds
  FROM public.edge_windows
  GROUP BY event_id
`;
const SQL_FILTERED_PER_EVENT = `
  SELECT
    w.event_id,
    COUNT(*)::integer AS total_trades,
    AVG(w.avg_edge)::double precision AS avg_edge,
    AVG(w.duration_seconds)::double precision AS avg_duration_seconds
  FROM public.edge_windows w
  JOIN public.execution_signal_calibrated s
    ON w.candidate = s.candidate AND w.event_id = s.event_id
  WHERE s.score_percentile >= $1
  GROUP BY w.event_id
`;

function formatNum(x) {
  if (x == null) return 'null';
  if (Number.isInteger(x)) return String(x);
  return Number(x).toFixed(6);
}

function pad(str, width) {
  const s = String(str);
  if (s.length >= width) return s;
  return s + ' '.repeat(width - s.length);
}

function printBlock(title, r) {
  console.log(title);
  console.log('total_trades:', r.total_trades ?? 0);
  console.log('avg_edge:', formatNum(r.avg_edge));
  console.log('avg_duration:', formatNum(r.avg_duration_seconds));
  console.log('median_duration:', formatNum(r.median_duration));
  console.log('total_edge_sum:', formatNum(r.total_edge_sum));
  console.log('');
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error('DATABASE_URL is required. Set it in .env (Supabase connection string).');
    process.exit(1);
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    // 1. Identify all (candidate, event_id) pairs in edge_windows
    const pairsRes = await client.query(SQL_EDGE_WINDOWS_PAIRS);
    const pairs = pairsRes.rows || [];
    console.log('===== EVENT PAIRS IN edge_windows =====');
    console.log('(candidate, event_id) count:', pairs.length);
    pairs.forEach((r) => console.log('  ', r.candidate, '|', r.event_id));
    console.log('');

    const naiveRes = await client.query(SQL_NAIVE);
    const filteredRes = await client.query(SQL_FILTERED, [0.9]);
    const naive = naiveRes.rows[0];
    const filtered = filteredRes.rows[0];

    console.log('===== GLOBAL SUMMARY (all events) =====');
    console.log('===== NAIVE STRATEGY =====');
    printBlock('', naive);

    console.log('===== FILTERED STRATEGY (>= 0.9) =====');
    printBlock('', filtered);

    const nEdge = naive?.avg_edge != null && Number(naive.avg_edge) !== 0 ? Number(naive.avg_edge) : null;
    const nDur = naive?.avg_duration_seconds != null && Number(naive.avg_duration_seconds) !== 0 ? Number(naive.avg_duration_seconds) : null;
    const fEdge = filtered?.avg_edge != null ? Number(filtered.avg_edge) : null;
    const fDur = filtered?.avg_duration_seconds != null ? Number(filtered.avg_duration_seconds) : null;

    if (nEdge != null && fEdge != null) {
      const edgeLift = nEdge ? fEdge / nEdge : 0;
      const edgePct = (edgeLift - 1) * 100;
      console.log('edge_lift =', formatNum(edgeLift), `(${edgePct >= 0 ? '+' : ''}${formatNum(edgePct)}% vs naive)`);
    }
    if (nDur != null && fDur != null) {
      const durationLift = nDur ? fDur / nDur : 0;
      const durationPct = (durationLift - 1) * 100;
      console.log('duration_lift =', formatNum(durationLift), `(${durationPct >= 0 ? '+' : ''}${formatNum(durationPct)}% vs naive)`);
    }

    // ----- Per-event breakdown (filtered >= 0.9) -----
    const naivePerEventRes = await client.query(SQL_NAIVE_PER_EVENT);
    const filteredPerEventRes = await client.query(SQL_FILTERED_PER_EVENT, [0.9]);
    const naiveByEvent = new Map((naivePerEventRes.rows || []).map((r) => [r.event_id, r]));
    const filteredByEvent = new Map((filteredPerEventRes.rows || []).map((r) => [r.event_id, r]));

    const eventIds = [...new Set([...naiveByEvent.keys(), ...filteredByEvent.keys()])].sort();

    console.log('\n===== PER-EVENT BREAKDOWN (filtered >= 0.9) =====\n');
    console.log('event_id | total_trades | avg_edge | avg_duration | edge_lift | duration_lift');
    console.log('--------------------------------------------------------------------------------');

    for (const eid of eventIds) {
      const n = naiveByEvent.get(eid);
      const f = filteredByEvent.get(eid);
      const totalTrades = f ? Number(f.total_trades) || 0 : 0;
      const avgEdge = f?.avg_edge != null ? Number(f.avg_edge) : null;
      const avgDur = f?.avg_duration_seconds != null ? Number(f.avg_duration_seconds) : null;
      const nEdge = n?.avg_edge != null && Number(n.avg_edge) !== 0 ? Number(n.avg_edge) : null;
      const nDur = n?.avg_duration_seconds != null && Number(n.avg_duration_seconds) !== 0 ? Number(n.avg_duration_seconds) : null;
      let edgeLift = null;
      let durationLift = null;
      if (nEdge != null && avgEdge != null) edgeLift = avgEdge / nEdge;
      if (nDur != null && avgDur != null) durationLift = avgDur / nDur;

      const eventIdStr = String(eid).length > 42 ? String(eid).slice(0, 39) + '...' : String(eid);
      const line =
        pad(eventIdStr, 42) + ' | ' +
        pad(totalTrades, 12) + ' | ' +
        pad(avgEdge != null ? Number(avgEdge).toFixed(6) : '—', 8) + ' | ' +
        pad(avgDur != null ? Number(avgDur).toFixed(6) : '—', 11) + ' | ' +
        pad(edgeLift != null ? Number(edgeLift).toFixed(6) : '—', 9) + ' | ' +
        pad(durationLift != null ? Number(durationLift).toFixed(6) : '—', 13);
      console.log(line);
    }

    // Threshold sweep: 0.5 to 0.95 in 0.05 steps.
    const thresholds = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95];
    const naiveEdge = naive?.avg_edge != null ? Number(naive.avg_edge) : null;
    const naiveDur = naive?.avg_duration_seconds != null ? Number(naive.avg_duration_seconds) : null;

    console.log('\n===== THRESHOLD SWEEP =====\n');
    console.log('threshold | trades | avg_edge | avg_duration | edge_lift | duration_lift');
    console.log('---------------------------------------------------------------------------');

    for (const t of thresholds) {
      const sweepRes = await client.query(SQL_FILTERED, [t]);
      const row = sweepRes.rows[0] || {};

      const trades = Number(row.total_trades) || 0;
      const avgEdge = row.avg_edge != null ? Number(row.avg_edge) : null;
      const avgDur = row.avg_duration_seconds != null ? Number(row.avg_duration_seconds) : null;

      let edgeLift = null;
      let durationLift = null;

      if (naiveEdge != null && naiveEdge !== 0 && avgEdge != null) {
        edgeLift = avgEdge / naiveEdge;
      }
      if (naiveDur != null && naiveDur !== 0 && avgDur != null) {
        durationLift = avgDur / naiveDur;
      }

      const line =
        pad(t.toFixed(2), 9) + '|' +
        ' ' + pad(trades, 6) + ' | ' +
        pad(avgEdge != null ? Number(avgEdge).toFixed(6) : '0', 8) + ' | ' +
        pad(avgDur != null ? Number(avgDur).toFixed(6) : '0', 11) + ' | ' +
        pad(edgeLift != null ? Number(edgeLift).toFixed(6) : '0', 9) + ' | ' +
        pad(durationLift != null ? Number(durationLift).toFixed(6) : '0', 13);

      console.log(line);
    }

    // ----- Stability-weighted experiment (in-memory only; no schema / persistence) -----
    const calibratedRes = await client.query(SQL_CALIBRATED_ALL);
    const calibratedRows = calibratedRes.rows || [];
    const withStability = calibratedRows.map((r) => ({
      candidate: r.candidate,
      event_id: r.event_id,
      score_percentile: Number(r.score_percentile) || 0,
      avg_duration_seconds: Number(r.avg_duration_seconds) || 0,
      stability_score: (Number(r.score_percentile) || 0) * Math.log(1 + (Number(r.avg_duration_seconds) || 0)),
    }));
    withStability.sort((a, b) => b.stability_score - a.stability_score);
    const nCal = withStability.length;
    withStability.forEach((row, i) => {
      row.stable_percentile = nCal <= 1 ? 1 : (nCal - 1 - i) / (nCal - 1);
    });

    console.log('\n===== STABILITY-WEIGHTED SWEEP =====\n');
    console.log('threshold | trades | avg_edge | avg_duration | edge_lift | duration_lift');
    console.log('---------------------------------------------------------------------------');

    for (const t of thresholds) {
      const included = withStability.filter((r) => r.stable_percentile >= t);
      const candidates = included.map((r) => r.candidate);
      const eventIds = included.map((r) => r.event_id);

      let row = { total_trades: 0, avg_edge: null, avg_duration_seconds: null, total_edge_sum: null, median_duration: null };
      if (candidates.length > 0) {
        const stabRes = await client.query(SQL_STABILITY_FILTERED, [candidates, eventIds]);
        row = stabRes.rows[0] || row;
      }

      const trades = Number(row.total_trades) || 0;
      const avgEdge = row.avg_edge != null ? Number(row.avg_edge) : null;
      const avgDur = row.avg_duration_seconds != null ? Number(row.avg_duration_seconds) : null;
      let edgeLift = null;
      let durationLift = null;
      if (naiveEdge != null && naiveEdge !== 0 && avgEdge != null) edgeLift = avgEdge / naiveEdge;
      if (naiveDur != null && naiveDur !== 0 && avgDur != null) durationLift = avgDur / naiveDur;

      const line =
        pad(t.toFixed(2), 9) + '|' +
        ' ' + pad(trades, 6) + ' | ' +
        pad(avgEdge != null ? Number(avgEdge).toFixed(6) : '0', 8) + ' | ' +
        pad(avgDur != null ? Number(avgDur).toFixed(6) : '0', 11) + ' | ' +
        pad(edgeLift != null ? Number(edgeLift).toFixed(6) : '0', 9) + ' | ' +
        pad(durationLift != null ? Number(durationLift).toFixed(6) : '0', 13);
      console.log(line);
    }

    // ----- Min duration filter: threshold sweep on windows with duration_seconds >= minDuration -----
    const minDurations = [0, 60, 120, 300];
    for (const minDuration of minDurations) {
      console.log('\n===== MIN DURATION FILTER: >= ' + minDuration + ' seconds =====');
      console.log('threshold | trades | avg_edge | avg_duration | edge_lift | duration_lift');
      console.log('---------------------------------------------------------------------------');

      for (const t of thresholds) {
        const sweepRes = await client.query(SQL_MIN_DURATION_FILTERED, [minDuration, t]);
        const row = sweepRes.rows[0] || {};

        const trades = Number(row.total_trades) || 0;
        const avgEdge = row.avg_edge != null ? Number(row.avg_edge) : null;
        const avgDur = row.avg_duration_seconds != null ? Number(row.avg_duration_seconds) : null;
        let edgeLift = null;
        let durationLift = null;
        if (naiveEdge != null && naiveEdge !== 0 && avgEdge != null) edgeLift = avgEdge / naiveEdge;
        if (naiveDur != null && naiveDur !== 0 && avgDur != null) durationLift = avgDur / naiveDur;

        const line =
          pad(t.toFixed(2), 9) + '|' +
          ' ' + pad(trades, 6) + ' | ' +
          pad(avgEdge != null ? Number(avgEdge).toFixed(6) : '0', 8) + ' | ' +
          pad(avgDur != null ? Number(avgDur).toFixed(6) : '0', 11) + ' | ' +
          pad(edgeLift != null ? Number(edgeLift).toFixed(6) : '0', 9) + ' | ' +
          pad(durationLift != null ? Number(durationLift).toFixed(6) : '0', 13);
        console.log(line);
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
