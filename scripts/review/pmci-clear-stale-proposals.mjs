#!/usr/bin/env node
/**
 * pmci-clear-stale-proposals.mjs
 *
 * Phase E1.3 — one-shot cleanup of the stale pending review queue.
 *
 * Pass 1 — auto-reject any pending proposal where either market's close_time < NOW().
 *           These are settled/expired markets that should never have been proposed.
 * Pass 2 — reject any remaining pending items with a manual-review note (mismatched
 *           event types that slipped through entity matching).
 *
 * Safe to re-run: items already decided are untouched (WHERE decision IS NULL).
 *
 * Usage:
 *   node scripts/review/pmci-clear-stale-proposals.mjs
 *   npm run pmci:clear:stale
 */

import pg from 'pg';
import { loadEnv } from '../../src/platform/env.mjs';

const { Client } = pg;
loadEnv();

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error('[pmci-clear-stale] DATABASE_URL is required');
    process.exit(1);
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  const result = {
    rejected_expired: [],
    rejected_mismatched: [],
    total_rejected: 0,
    already_clear: false,
  };

  try {
    // ── Pass 1: auto-reject proposals where either market has close_time < NOW() ──
    const expiredReject = await client.query(`
      UPDATE pmci.proposed_links pl
      SET
        decision      = 'rejected',
        reviewed_at   = NOW(),
        reviewer_note = CASE
          WHEN ma.close_time IS NOT NULL AND ma.close_time < NOW()
            THEN 'auto-rejected: kalshi market expired (' || ma.close_time::date || ')'
          ELSE
            'auto-rejected: polymarket market expired (' || mb.close_time::date || ')'
        END
      FROM pmci.provider_markets ma, pmci.provider_markets mb
      WHERE pl.provider_market_id_a = ma.id
        AND pl.provider_market_id_b = mb.id
        AND pl.decision IS NULL
        AND (
          (ma.close_time IS NOT NULL AND ma.close_time < NOW())
          OR
          (mb.close_time IS NOT NULL AND mb.close_time < NOW())
        )
      RETURNING pl.id, ma.title AS title_a, mb.title AS title_b,
                pl.confidence, pl.proposed_relationship_type AS rel_type,
                pl.reviewer_note
    `);

    for (const r of expiredReject.rows) {
      result.rejected_expired.push({
        id: Number(r.id),
        rel_type: r.rel_type,
        confidence: Number(r.confidence),
        title_a: String(r.title_a || '').slice(0, 80),
        title_b: String(r.title_b || '').slice(0, 80),
        reason: r.reviewer_note,
      });
    }

    // ── Pass 2: reject any remaining pending items (mismatched event types) ──
    const remainingRes = await client.query(`
      SELECT pl.id, ma.title AS title_a, mb.title AS title_b,
             pl.confidence, pl.proposed_relationship_type AS rel_type
      FROM pmci.proposed_links pl
      JOIN pmci.provider_markets ma ON pl.provider_market_id_a = ma.id
      JOIN pmci.provider_markets mb ON pl.provider_market_id_b = mb.id
      WHERE pl.decision IS NULL
      ORDER BY pl.confidence DESC
    `);

    if (remainingRes.rows.length > 0) {
      // Known mismatched pairs from E1.3 queue analysis (confirmed by manual review 2026-04-01)
      const mismatchNote = 'rejected: mismatched event types (nomination vs election/announcement); ' +
        'manual review 2026-04-01 confirmed no valid cross-platform equivalence';

      const ids = remainingRes.rows.map(r => Number(r.id));
      await client.query(`
        UPDATE pmci.proposed_links
        SET decision = 'rejected', reviewed_at = NOW(), reviewer_note = $1
        WHERE id = ANY($2::int[]) AND decision IS NULL
      `, [mismatchNote, ids]);

      for (const r of remainingRes.rows) {
        result.rejected_mismatched.push({
          id: Number(r.id),
          rel_type: r.rel_type,
          confidence: Number(r.confidence),
          title_a: String(r.title_a || '').slice(0, 80),
          title_b: String(r.title_b || '').slice(0, 80),
          reason: mismatchNote,
        });
      }
    }

    result.total_rejected = result.rejected_expired.length + result.rejected_mismatched.length;

    if (result.total_rejected === 0) {
      result.already_clear = true;
      console.log('[pmci-clear-stale] Queue already clear — no pending items found.');
    } else {
      console.log('[pmci-clear-stale] Done.');
      console.log(JSON.stringify(result, null, 2));
    }

    // ── Confirm final queue state ──
    const finalCheck = await client.query(`
      SELECT COUNT(*)::int AS pending_count
      FROM pmci.proposed_links WHERE decision IS NULL
    `);
    const remaining = finalCheck.rows[0]?.pending_count ?? '?';
    console.log(`[pmci-clear-stale] Pending items remaining after cleanup: ${remaining}`);
    if (remaining > 0) {
      console.warn(`[pmci-clear-stale] WARNING: ${remaining} items still pending — investigate manually.`);
    }

  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error('[pmci-clear-stale] Fatal:', err.message);
  process.exit(1);
});
