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

const args = process.argv.slice(2);
let debugMode = false;
let dumpCsvPath = null;
let pmciExportPath = null;
let baseThreshold = 0.9;

for (const arg of args) {
  if (arg === '--debug') {
    debugMode = true;
  } else if (arg.startsWith('--dump-csv')) {
    const [, value] = arg.split('=');
    dumpCsvPath = value && value.length > 0 ? value : 'backtest_windows.csv';
  } else if (arg.startsWith('--pmci-export')) {
    const [, value] = arg.split('=');
    pmciExportPath = value && value.length > 0 ? value : 'pmci_backtest_export.json';
  } else if (arg.startsWith('--threshold=')) {
    const [, value] = arg.split('=');
    const parsed = parseFloat(value);
    if (!Number.isNaN(parsed) && parsed > 0 && parsed < 1) {
      baseThreshold = parsed;
    }
  }
}

const SQL_NAIVE = `
  SELECT
    COUNT(*)::integer AS total_trades,
    AVG(avg_edge)::double precision AS avg_edge,
    AVG(duration_seconds)::double precision AS avg_duration_seconds,
    SUM(avg_edge)::double precision AS total_edge_sum,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_seconds)::double precision AS median_duration
  FROM public.edge_windows
  WHERE duration_seconds > 0
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
  WHERE w.duration_seconds > 0
    AND s.score_percentile >= $1
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
    AND w.duration_seconds > 0
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
  WHERE w.duration_seconds > 0
    AND w.duration_seconds >= $1
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
  WHERE duration_seconds > 0
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
  WHERE w.duration_seconds > 0
    AND s.score_percentile >= $1
  GROUP BY w.event_id
`;
const SQL_WINDOWS_DEBUG = `
  SELECT
    w.candidate,
    w.event_id,
    w.edge_start,
    w.edge_end,
    w.duration_seconds,
    w.avg_edge,
    s.score_percentile,
    p.source_meta
  FROM public.edge_windows w
  LEFT JOIN public.execution_signal_calibrated s
    ON w.candidate = s.candidate
   AND w.event_id = s.event_id
  LEFT JOIN LATERAL (
    SELECT source_meta
    FROM public.prediction_market_spreads p
    WHERE p.candidate = w.candidate
      AND p.event_id = w.event_id
    ORDER BY p.observed_at DESC
    LIMIT 1
  ) p ON true
`;
const SQL_SPREADS_PAIRS = `
  SELECT DISTINCT candidate, event_id
  FROM public.prediction_market_spreads
`;
const SQL_REJECTION_COUNTS = `
  SELECT event_id, rejection_reason, COUNT(*)::integer AS cnt
  FROM public.edge_windows_generation
  WHERE rejection_reason IS NOT NULL
  GROUP BY event_id, rejection_reason
  ORDER BY event_id, rejection_reason
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

function median(nums) {
  if (!nums || nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function familyKey(eventId, candidate) {
  return `${eventId}::${candidate}`;
}

function loadConfigPairs() {
  const byKey = new Map();
  const byEvent = new Map();
  const pairs = [];

  // Prefer canonical scripts/prediction_market_event_pairs.json, fall back to root event_pairs.json
  const candidates = [
    path.join(process.cwd(), 'scripts', 'prediction_market_event_pairs.json'),
    path.join(process.cwd(), 'event_pairs.json'),
  ];

  let raw = null;
  for (const p of candidates) {
    try {
      raw = fs.readFileSync(p, 'utf8');
      break;
    } catch (_) {}
  }
  if (!raw) return { pairs, byKey, byEvent };

  try {
    const arr = JSON.parse(raw);
    for (const row of arr) {
      const eventId = row.polymarketSlug;
      const candidate = row.polymarketOutcomeName;
      const key = familyKey(eventId, candidate);
      const entry = {
        event_id: eventId,
        candidate,
        kalshiTicker: row.kalshiTicker,
        polymarketSlug: row.polymarketSlug,
        polymarketOutcomeName: row.polymarketOutcomeName,
        eventName: row.eventName,
      };
      pairs.push(entry);
      byKey.set(key, entry);
      if (!byEvent.has(eventId)) byEvent.set(eventId, []);
      byEvent.get(eventId).push(entry);
    }
  } catch (_) {
    // best-effort only
  }

  return { pairs, byKey, byEvent };
}

async function analyzeWindows(client, { threshold, debugMode, dumpCsvPath, pmciExportPath, rejectionByEvent = null }) {
  const [windowsRes, spreadsRes] = await Promise.all([
    client.query(SQL_WINDOWS_DEBUG),
    client.query(SQL_SPREADS_PAIRS),
  ]);
  const windowsRows = windowsRes.rows || [];
  const spreadsPairs = new Set(
    (spreadsRes.rows || []).map((r) => familyKey(r.event_id, r.candidate)),
  );

  const config = loadConfigPairs();

  const coverageByEvent = new Map();
  const familyStatsByKey = new Map();
  const failureReasons = [
    'missing_pair_mapping',
    'missing_prices',
    'insufficient_history',
    'low_confidence',
    'duration_zero_or_invalid',
    'category_mismatch',
    'rejected_at_generation',
  ];

  const windowsExport = [];

  function ensureEventStats(eventId) {
    if (!coverageByEvent.has(eventId)) {
      const obj = {
        event_id: eventId,
        windows_total: 0,
        windows_filtered: 0,
        failure_reasons: {},
        valid_durations: [],
      };
      failureReasons.forEach((r) => {
        obj.failure_reasons[r] = 0;
      });
      coverageByEvent.set(eventId, obj);
    }
    return coverageByEvent.get(eventId);
  }

  function ensureFamilyStats(eventId, candidate) {
    const key = familyKey(eventId, candidate);
    if (!familyStatsByKey.has(key)) {
      familyStatsByKey.set(key, {
        family_key: key,
        event_id: eventId,
        candidate,
        windows_total: 0,
        windows_filtered: 0,
        failure_reasons: {},
      });
    }
    const fs = familyStatsByKey.get(key);
    failureReasons.forEach((r) => {
      if (!(r in fs.failure_reasons)) fs.failure_reasons[r] = 0;
    });
    return fs;
  }

  // Per-window analysis
  for (const row of windowsRows) {
    const eventId = row.event_id;
    const candidate = row.candidate;
    const key = familyKey(eventId, candidate);
    const cfg = config.byKey.get(key);

    const durationSeconds =
      row.duration_seconds == null ? null : Number(row.duration_seconds);
    const durationValid = durationSeconds != null && durationSeconds > 0;
    const score =
      row.score_percentile == null ? null : Number(row.score_percentile);

    let pass = false;
    let reason;
    if (!cfg) {
      reason = 'missing_pair_mapping';
    } else if (!durationValid) {
      reason = 'duration_zero_or_invalid';
    } else if (score == null) {
      reason = 'insufficient_history';
    } else if (score < threshold) {
      reason = 'low_confidence';
    } else {
      pass = true;
      reason = 'pass';
    }

    const evStats = ensureEventStats(eventId);
    const famStats = ensureFamilyStats(eventId, candidate);

    evStats.windows_total += 1;
    famStats.windows_total += 1;

    if (pass) {
      evStats.windows_filtered += 1;
      famStats.windows_filtered += 1;
    } else if (reason && reason !== 'pass') {
      if (!(reason in evStats.failure_reasons)) evStats.failure_reasons[reason] = 0;
      if (!(reason in famStats.failure_reasons)) famStats.failure_reasons[reason] = 0;
      evStats.failure_reasons[reason] += 1;
      famStats.failure_reasons[reason] += 1;
    }

    if (durationValid) {
      evStats.valid_durations.push(durationSeconds);
    }

    windowsExport.push({
      family_key: key,
      ts_start: row.edge_start,
      ts_end: row.edge_end,
      edge: row.avg_edge == null ? null : Number(row.avg_edge),
      score,
      pass,
      reason: reason || null,
    });
  }

  // Config coverage: detect pairs with no prices
  for (const cfg of config.pairs) {
    const key = familyKey(cfg.event_id, cfg.candidate);
    const evStats = ensureEventStats(cfg.event_id);
    const famStats = ensureFamilyStats(cfg.event_id, cfg.candidate);
    const hasSpreads = spreadsPairs.has(key);
    const hasWindows = famStats.windows_total > 0;

    if (!hasSpreads) {
      evStats.failure_reasons.missing_prices += 1;
      famStats.failure_reasons.missing_prices += 1;
    } else if (!hasWindows) {
      // Prices exist but no executable windows; treat as low_confidence for now.
      evStats.failure_reasons.low_confidence += 1;
      famStats.failure_reasons.low_confidence += 1;
    }
  }

  // Rejected-at-generation stats (from edge_windows_generation view)
  if (rejectionByEvent) {
    for (const [eid, data] of rejectionByEvent.entries()) {
      const evStats = ensureEventStats(eid);
      evStats.failure_reasons.rejected_at_generation = data.total;
    }
  }

  // Debug print per-event breakdown
  if (debugMode) {
    console.log('\n===== PMCI COVERAGE / REJECTION BREAKDOWN =====\n');
    const eventIds = [...coverageByEvent.keys()].sort();
    for (const eid of eventIds) {
      const s = coverageByEvent.get(eid);
      const med = median(s.valid_durations);
      console.log(`event_id=${eid}`);
      console.log('  windows_total:', s.windows_total);
      console.log(`  windows_filtered(threshold>=${threshold}):`, s.windows_filtered);
      console.log('  valid_duration_median_seconds:', med == null ? 'null' : formatNum(med));
      if (rejectionByEvent && rejectionByEvent.has(eid)) {
        const rej = rejectionByEvent.get(eid);
        console.log('  windows_rejected_at_generation:', rej.total);
        console.log('  rejected_at_generation_breakdown:', rej.breakdown);
      }
      console.log('  failure_reasons:');
      for (const r of failureReasons) {
        const count = s.failure_reasons[r] ?? 0;
        if (count > 0) {
          console.log(`    - ${r}: ${count}`);
        }
      }
      console.log('');
    }
  }

  // CSV dump (windows-level)
  if (dumpCsvPath) {
    const header = [
      'event_id',
      'candidate',
      'edge',
      'score',
      'pass',
      'reason',
      'duration_seconds',
      'providerA',
      'providerB',
      'marketA',
      'marketB',
      'ts_start',
      'ts_end',
    ].join(',');

    const lines = [header];
    for (const w of windowsRows) {
      const eventId = w.event_id;
      const candidate = w.candidate;
      const key = familyKey(eventId, candidate);
      const cfg = config.byKey.get(key);
      const durationSeconds =
        w.duration_seconds == null ? '' : String(Number(w.duration_seconds));
      const score =
        w.score_percentile == null ? '' : String(Number(w.score_percentile));

      let pass = '';
      let reason = '';
      const famStats = familyStatsByKey.get(key);
      const winExport = windowsExport.find(
        (we) =>
          we.family_key === key &&
          we.ts_start === w.edge_start &&
          we.ts_end === w.edge_end,
      );
      if (winExport) {
        pass = String(winExport.pass);
        reason = winExport.reason || '';
      }

      const providerA = 'kalshi';
      const providerB = 'polymarket';
      const marketA = cfg ? cfg.kalshiTicker : '';
      const marketB = cfg
        ? `${cfg.polymarketSlug}#${cfg.polymarketOutcomeName}`
        : '';

      const row = [
        eventId,
        candidate,
        w.avg_edge == null ? '' : String(Number(w.avg_edge)),
        score,
        pass,
        reason,
        durationSeconds,
        providerA,
        providerB,
        marketA,
        marketB,
        w.edge_start,
        w.edge_end,
      ].join(',');
      lines.push(row);
    }

    fs.writeFileSync(dumpCsvPath, `${lines.join('\n')}\n`, 'utf8');
    console.log(`\nDebug CSV written to ${dumpCsvPath}`);
  }

  // PMCI export JSON
  if (pmciExportPath) {
    const families = [];
    const links = [];

    for (const [key, fsStats] of familyStatsByKey.entries()) {
      families.push({
        family_key: key,
        event_id: fsStats.event_id,
        candidate: fsStats.candidate,
        stats: {
          windows_total: fsStats.windows_total,
          windows_filtered: fsStats.windows_filtered,
          failure_reasons: fsStats.failure_reasons,
        },
      });

      const cfg = config.byKey.get(key);
      if (cfg) {
        links.push({
          family_key: key,
          provider_market_a: `kalshi:${cfg.kalshiTicker}`,
          provider_market_b: `polymarket:${cfg.polymarketSlug}:${cfg.polymarketOutcomeName}`,
          relationship_type: 'equivalent',
          confidence: 0.99,
          reasons: {
            mapping_source: 'prediction_market_event_pairs.json',
            event_name: cfg.eventName,
          },
        });
      }
    }

    const exportObj = {
      threshold,
      families,
      links,
      windows: windowsExport,
    };

    fs.writeFileSync(
      pmciExportPath,
      `${JSON.stringify(exportObj, null, 2)}\n`,
      'utf8',
    );
    console.log(`PMCI export written to ${pmciExportPath}`);
  }

  // Short final summary: GOP vs DEM coverage
  const interestingEvents = [...coverageByEvent.keys()].sort();
  if (interestingEvents.length > 0) {
    console.log('\n===== PMCI COVERAGE SUMMARY (by event) =====\n');
    for (const eid of interestingEvents) {
      const s = coverageByEvent.get(eid);
      const med = median(s.valid_durations);
      console.log(`event_id=${eid}`);
      console.log('  windows_total:', s.windows_total);
      console.log(
        `  windows_filtered(threshold>=${threshold}):`,
        s.windows_filtered,
      );
      console.log(
        '  valid_duration_median_seconds:',
        med == null ? 'null' : formatNum(med),
      );
      if (rejectionByEvent && rejectionByEvent.has(eid)) {
        const rej = rejectionByEvent.get(eid);
        console.log('  windows_rejected_at_generation:', rej.total);
        console.log('  rejected_at_generation_breakdown:', rej.breakdown);
      }
    }
    console.log('');
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error('DATABASE_URL is required. Set it in .env (Supabase connection string).');
    process.exit(1);
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  let rejectionByEvent = null;
  try {
    const rejRes = await client.query(SQL_REJECTION_COUNTS);
    const rows = rejRes.rows || [];
    rejectionByEvent = new Map();
    for (const r of rows) {
      const eid = r.event_id;
      if (!rejectionByEvent.has(eid)) {
        rejectionByEvent.set(eid, { total: 0, breakdown: {} });
      }
      const rec = rejectionByEvent.get(eid);
      const reason = r.rejection_reason || 'unknown';
      const cnt = Number(r.cnt) || 0;
      rec.breakdown[reason] = cnt;
      rec.total += cnt;
    }
  } catch (err) {
    if (debugMode || dumpCsvPath || pmciExportPath) {
      console.warn('edge_windows_generation not available (run migration 20260225100000):', err.message);
    }
  }

  try {
    // 1. Identify all (candidate, event_id) pairs in edge_windows
    const pairsRes = await client.query(SQL_EDGE_WINDOWS_PAIRS);
    const pairs = pairsRes.rows || [];
    console.log('===== EVENT PAIRS IN edge_windows =====');
    console.log('(candidate, event_id) count:', pairs.length);
    pairs.forEach((r) => console.log('  ', r.candidate, '|', r.event_id));
    console.log('');

    const naiveRes = await client.query(SQL_NAIVE);
    const filteredRes = await client.query(SQL_FILTERED, [baseThreshold]);
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
    const filteredPerEventRes = await client.query(SQL_FILTERED_PER_EVENT, [baseThreshold]);
    const naiveByEvent = new Map((naivePerEventRes.rows || []).map((r) => [r.event_id, r]));
    const filteredByEvent = new Map((filteredPerEventRes.rows || []).map((r) => [r.event_id, r]));

    const eventIds = [...new Set([...naiveByEvent.keys(), ...filteredByEvent.keys()])].sort();

    console.log(`\n===== PER-EVENT BREAKDOWN (filtered >= ${baseThreshold}) =====\n`);
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

    if (debugMode || dumpCsvPath || pmciExportPath) {
      await analyzeWindows(client, {
        threshold: baseThreshold,
        debugMode,
        dumpCsvPath,
        pmciExportPath,
        rejectionByEvent,
      });
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
