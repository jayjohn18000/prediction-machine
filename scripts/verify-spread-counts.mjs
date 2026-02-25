#!/usr/bin/env node
/** Quick verify: count distinct candidates in prediction_market_spreads. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '..', '.env');
try {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach((line) => {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  });
} catch (_) {}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env');
  process.exit(1);
}

const supabase = createClient(url, key);

const { data: rows, error } = await supabase.from('prediction_market_spreads').select('candidate');
if (error) {
  console.error('Query error:', error.message);
  process.exit(1);
}
const distinct = new Set((rows || []).map((r) => r.candidate));
const byCandidate = (rows || []).reduce((acc, r) => { acc[r.candidate] = (acc[r.candidate] || 0) + 1; return acc; }, {});
console.log('COUNT(DISTINCT candidate):', distinct.size);
console.log('Candidates:', [...distinct].sort().join(', '));
console.log('\nRows per candidate (DESC):');
Object.entries(byCandidate)
  .sort((a, b) => b[1] - a[1])
  .forEach(([c, n]) => console.log(`  ${n}\t${c}`));
