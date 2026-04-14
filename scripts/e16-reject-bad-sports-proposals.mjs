/**
 * E1.6: reject pending sports proposed_links that match strict-audit semantic violation
 * (same definition as scripts/audit/pmci-sports-audit-packet.mjs).
 */
import { loadEnv } from '../src/platform/env.mjs';
import pg from 'pg';

loadEnv();
const { Client } = pg;
const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

const res = await c.query(`
  UPDATE pmci.proposed_links pl
  SET decision = 'rejected',
      reviewed_at = now(),
      reviewer_note = 'E1.6 semantic violation auto-reject (audit gate)'
  FROM pmci.provider_markets a, pmci.provider_markets b
  WHERE pl.category = 'sports'
    AND pl.decision IS NULL
    AND a.id = pl.provider_market_id_a
    AND b.id = pl.provider_market_id_b
    AND (
      coalesce(a.sport, 'unknown') <> coalesce(b.sport, 'unknown')
      OR abs(a.game_date - b.game_date) > 1
    )
`);
console.log('[e16-reject] Rejected rows:', res.rowCount);
await c.end();
