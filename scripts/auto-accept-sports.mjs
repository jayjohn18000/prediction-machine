/**
 * E1.5 gate helper: auto-accept top N sports proposals via the review API.
 */
import { loadEnv } from '../src/platform/env.mjs';
import pg from '../node_modules/pg/lib/index.js';

loadEnv();

const BASE = (process.env.API_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const API_KEY = process.env.PMCI_API_KEY || '';
const ADMIN_KEY = process.env.PMCI_ADMIN_KEY || '';
const N = 10;

console.log('API base:', BASE);
console.log('API key:', API_KEY ? 'YES (' + API_KEY.slice(0,4) + '...)' : 'MISSING');

const { Client } = pg;
const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

const { rows: proposals } = await c.query(`
  SELECT pl.id, pl.confidence,
    pm_a.title as title_a, pm_a.sport, pm_a.game_date::text,
    pm_b.title as title_b,
    pa.code as provider_a, pb.code as provider_b
  FROM pmci.proposed_links pl
  JOIN pmci.provider_markets pm_a ON pl.provider_market_id_a = pm_a.id
  JOIN pmci.provider_markets pm_b ON pl.provider_market_id_b = pm_b.id
  JOIN pmci.providers pa ON pa.id = pm_a.provider_id
  JOIN pmci.providers pb ON pb.id = pm_b.provider_id
  WHERE pl.category = 'sports'
    AND pl.decision IS NULL
    AND pa.code != pb.code
  ORDER BY pl.confidence DESC, pl.id ASC
  LIMIT $1
`, [N]);

console.log('Found ' + proposals.length + ' undecided cross-provider proposals');
await c.end();

let accepted = 0;
let failed = 0;
for (const p of proposals) {
  const body = JSON.stringify({
    proposed_id: Number(p.id),
    decision: 'accept',
    relationship_type: 'equivalent',
    note: 'E1.5 gate auto-accept'
  });
  const headers = {
    'Content-Type': 'application/json',
    'x-pmci-api-key': API_KEY,
  };
  if (ADMIN_KEY) headers['x-pmci-admin-key'] = ADMIN_KEY;
  
  try {
    const res = await fetch(BASE + '/v1/review/decision', { method: 'POST', headers, body });
    const data = await res.json();
    if (data.error) {
      console.error('  FAILED [' + p.id + ']: ' + JSON.stringify(data.error));
      failed++;
    } else {
      console.log('  ACCEPTED [' + p.id + '] ' + p.sport + ' ' + p.game_date + ' — ' + p.title_a);
      accepted++;
    }
  } catch (err) {
    console.error('  ERROR [' + p.id + ']: ' + err.message);
    failed++;
  }
}

console.log('Done: accepted=' + accepted + ' failed=' + failed);

const c2 = new Client({ connectionString: process.env.DATABASE_URL });
await c2.connect();
const { rows: verify } = await c2.query(`
  SELECT ml.status, count(*) ct
  FROM pmci.market_links ml
  JOIN pmci.provider_markets pm ON ml.provider_market_id = pm.id
  WHERE pm.category = 'sports'
  GROUP BY ml.status
`);
console.log('market_links sports:', JSON.stringify(verify));
await c2.end();
