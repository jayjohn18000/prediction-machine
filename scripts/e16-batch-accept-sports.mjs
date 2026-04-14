/**
 * E1.6: accept up to N semantically safe pending sports proposals using review-service
 * (same DB path as POST /v1/review/decision). No HTTP server required.
 */
import { loadEnv } from '../src/platform/env.mjs';
import { query, withTransaction } from '../src/db.mjs';
import { SQL } from '../src/queries.mjs';
import { resolveProviderIdByCode } from '../src/repositories/providers-repo.mjs';
import { applyReviewDecision } from '../src/services/review-service.mjs';

loadEnv();

const limit = Math.min(800, Math.max(1, Number(process.env.E16_BATCH_ACCEPT_LIMIT || 400)));

const { rows } = await query(
  `
  SELECT pl.id
  FROM pmci.proposed_links pl
  JOIN pmci.provider_markets a ON a.id = pl.provider_market_id_a
  JOIN pmci.provider_markets b ON b.id = pl.provider_market_id_b
  JOIN pmci.providers pa ON pa.id = a.provider_id
  JOIN pmci.providers pb ON pb.id = b.provider_id
  WHERE pl.category = 'sports'
    AND pl.decision IS NULL
    AND pa.code <> pb.code
    AND coalesce(a.sport, 'unknown') = coalesce(b.sport, 'unknown')
    AND a.sport IS NOT NULL
    AND a.sport <> 'unknown'
    AND a.game_date IS NOT NULL
    AND b.game_date IS NOT NULL
    AND abs(a.game_date - b.game_date) <= 1
  ORDER BY pl.confidence DESC NULLS LAST, pl.id
  LIMIT $1
`,
  [limit],
);

let ok = 0;
let err = 0;
for (const r of rows) {
  const out = await applyReviewDecision({
    withTransaction,
    resolveProviderIdByCode,
    SQL,
    proposedId: Number(r.id),
    decision: 'accept',
    relationshipType: 'equivalent',
    note: 'E1.6 batch accept',
  });
  if (out.error) {
    err += 1;
    console.error('[e16-batch-accept] FAIL id=' + r.id + ' ' + JSON.stringify(out));
  } else {
    ok += 1;
  }
}

console.log('[e16-batch-accept] summary:', JSON.stringify({ tried: rows.length, accepted: ok, failed: err }));
