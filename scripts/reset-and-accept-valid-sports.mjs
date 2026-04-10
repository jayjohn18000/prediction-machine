/**
 * E1.5: Reset decision=NULL for sports proposals that are semantically valid
 * (same sport, game_date delta ≤ 1, matching matchupKey), then accept them via API.
 * These were rejected before the sport-inference fixes when sport was 'unknown'.
 */
import { loadEnv } from '../src/platform/env.mjs';
import pg from '../node_modules/pg/lib/index.js';
import { sportsEntityFromMarket, isSportsPairSemanticallyValid } from '../lib/matching/sports-helpers.mjs';

loadEnv();

const BASE = (process.env.API_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const API_KEY = process.env.PMCI_API_KEY || '';
const ADMIN_KEY = process.env.PMCI_ADMIN_KEY || '';
const ACCEPT_N = 10;

const { Client } = pg;
const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

// Find rejected proposals where current DB data shows they ARE valid
const { rows: candidates } = await c.query(`
  SELECT pl.id, pl.reasons,
    pm_a.id ma_id, pm_a.sport, pm_a.game_date::text gd_a,
    pm_a.home_team ha, pm_a.away_team aa, pm_a.title ta,
    pm_b.id mb_id, pm_b.sport sb, pm_b.game_date::text gd_b,
    pm_b.home_team hb, pm_b.away_team ab, pm_b.title tb,
    abs(pm_a.game_date - pm_b.game_date) as delta
  FROM pmci.proposed_links pl
  JOIN pmci.provider_markets pm_a ON pl.provider_market_id_a = pm_a.id
  JOIN pmci.provider_markets pm_b ON pl.provider_market_id_b = pm_b.id
  WHERE pl.category = 'sports'
    AND pl.decision = 'rejected'
    AND pm_a.sport = pm_b.sport
    AND pm_a.sport <> 'unknown'
    AND pm_a.game_date IS NOT NULL
    AND pm_b.game_date IS NOT NULL
    AND abs(pm_a.game_date - pm_b.game_date) <= 1
  ORDER BY pl.confidence DESC, pl.id ASC
`);

console.log('Rejected proposals with valid game dates: ' + candidates.length);

// Re-validate with current helper logic
const validIds = [];
for (const row of candidates) {
  const fakeA = { title: row.ta, sport: row.sport, game_date: row.gd_a, home_team: row.ha, away_team: row.aa };
  const fakeB = { title: row.tb, sport: row.sb, game_date: row.gd_b, home_team: row.hb, away_team: row.ab };
  const result = isSportsPairSemanticallyValid(fakeA, fakeB);
  if (result.ok) {
    validIds.push(row.id);
  }
}

console.log('Re-validated as valid: ' + validIds.length);
if (validIds.length === 0) {
  console.log('No valid proposals to reset. Exiting.');
  await c.end();
  process.exit(0);
}

// Reset decision=NULL for valid proposals (so they can be accepted)
const resetResult = await c.query(
  'UPDATE pmci.proposed_links SET decision = NULL WHERE id = ANY($1::int[]) AND category = \'sports\'',
  [validIds]
);
console.log('Reset ' + resetResult.rowCount + ' proposals to decision=NULL');
await c.end();

// Now accept top ACCEPT_N via API
const toAccept = validIds.slice(0, ACCEPT_N);
console.log('Accepting top ' + toAccept.length + ' via API...');

let accepted = 0;
let failed = 0;
for (const id of toAccept) {
  const body = JSON.stringify({
    proposed_id: Number(id),
    decision: 'accept',
    relationship_type: 'equivalent',
    note: 'E1.5 gate: valid pair reset after sport-inference fix'
  });
  const headers = { 'Content-Type': 'application/json', 'x-pmci-api-key': API_KEY };
  if (ADMIN_KEY) headers['x-pmci-admin-key'] = ADMIN_KEY;
  try {
    const res = await fetch(BASE + '/v1/review/decision', { method: 'POST', headers, body });
    const data = await res.json();
    if (data.error) {
      console.error('  FAILED [' + id + ']: ' + JSON.stringify(data.error));
      failed++;
    } else {
      console.log('  ACCEPTED [' + id + ']');
      accepted++;
    }
  } catch (err) {
    console.error('  ERROR [' + id + ']: ' + err.message);
    failed++;
  }
}

console.log('Done: accepted=' + accepted + ' failed=' + failed);

// Verify market_links
const c2 = new Client({ connectionString: process.env.DATABASE_URL });
await c2.connect();
const { rows: ml } = await c2.query(`
  SELECT ml.status, count(DISTINCT ml.family_id) as families, count(*) as links
  FROM pmci.market_links ml
  JOIN pmci.provider_markets pm ON ml.provider_market_id = pm.id
  WHERE pm.category = 'sports'
  GROUP BY ml.status
`);
console.log('market_links sports:', JSON.stringify(ml));
await c2.end();
