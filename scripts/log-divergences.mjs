import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const API_BASE = (process.env.PMCI_API_BASE || 'http://localhost:8787').replace(/\/$/, '');
const API_KEY = process.env.PMCI_API_KEY || '';
const OUT_CSV = path.join(os.homedir(), 'divergence-log.csv');

async function fetchJson(url) {
  const headers = API_KEY ? { 'x-pmci-api-key': API_KEY } : {};
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

function csvEscape(v) {
  const s = String(v ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

function getLegPrice(legs, provider) {
  return legs?.find((l) => l.provider === provider)?.price_yes ?? '';
}

async function run() {
  const timestamp = new Date().toISOString();
  const events = await fetchJson(`${API_BASE}/v1/canonical-events`);

  const rows = [];
  const skipped = [];
  for (const evt of events) {
    try {
      const top = await fetchJson(
        `${API_BASE}/v1/signals/top-divergences?event_id=${encodeURIComponent(evt.id)}&limit=50`
      );

      for (const item of top) {
        rows.push({
          timestamp,
          event_slug: evt.slug ?? '',
          family_label: item.label ?? `family_${item.family_id}`,
          kalshi_price: getLegPrice(item.legs, 'kalshi'),
          polymarket_price: getLegPrice(item.legs, 'polymarket'),
          gap: item.max_divergence ?? '',
          max_divergence: item.max_divergence ?? '',
          consensus_price: item.consensus_price ?? ''
        });
      }
    } catch (err) {
      skipped.push({ event: evt.slug ?? evt.id, reason: err.message });
    }
  }

  const header = [
    'timestamp',
    'event_slug',
    'family_label',
    'kalshi_price',
    'polymarket_price',
    'gap',
    'max_divergence',
    'consensus_price'
  ];

  const exists = fs.existsSync(OUT_CSV);
  const lines = [];
  if (!exists) lines.push(header.join(','));

  for (const row of rows) {
    lines.push(header.map((k) => csvEscape(row[k])).join(','));
  }

  if (rows.length > 0) {
    fs.appendFileSync(OUT_CSV, `${lines.join('\n')}\n`, 'utf8');
  }

  const top3 = [...rows]
    .sort((a, b) => Number(b.max_divergence || 0) - Number(a.max_divergence || 0))
    .slice(0, 3);

  console.log(`Logged ${rows.length} families across ${events.length} events → ${OUT_CSV}`);
  if (skipped.length) {
    console.log(`Skipped ${skipped.length} events (example): ${skipped[0].event} | ${skipped[0].reason}`);
  }
  console.log('Top 3 gaps:');
  for (const r of top3) {
    const pct = (Number(r.max_divergence || 0) * 100).toFixed(2);
    console.log(`- ${r.event_slug} | ${r.family_label} | ${pct}pp`);
  }

  if (rows.length === 0) {
    throw new Error('No rows logged. Ensure PMCI observer is fresh and top-divergences is available.');
  }
}

run().catch((err) => {
  console.error('log-divergences failed:', err.message);
  process.exit(1);
});
