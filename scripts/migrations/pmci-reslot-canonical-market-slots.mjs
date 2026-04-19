#!/usr/bin/env node
/**
 * Phase G Phase 2: re-run classifyMarketTemplateForSlot + findOrCreateCanonicalMarketSlot for
 * already-attached sports/politics provider_markets so enriched template_params split overfilled slots.
 *
 * Usage:
 *   node scripts/migrations/pmci-reslot-canonical-market-slots.mjs --dry-run
 *   node scripts/migrations/pmci-reslot-canonical-market-slots.mjs --limit 500
 *
 * Env: DATABASE_URL
 */
import pg from "pg";
import { loadEnv } from "../../src/platform/env.mjs";
import {
  classifyMarketTemplateForSlot,
  findOrCreateCanonicalMarketSlot,
} from "../../lib/matching/event-matcher.mjs";

loadEnv();

const dry = process.argv.includes("--dry-run");
const limitArg = process.argv.indexOf("--limit");
const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : null;

function parseMetadata(raw) {
  if (raw == null) return {};
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return {};
}

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("DATABASE_URL required");
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  let sql = `
    SELECT pm.id, pm.title, pm.category, pm.provider_market_ref, pm.provider_id, pm.metadata,
           pmm.canonical_market_id AS old_cm_id,
           cm.canonical_event_id
    FROM pmci.provider_market_map pmm
    JOIN pmci.provider_markets pm ON pm.id = pmm.provider_market_id
    JOIN pmci.canonical_markets cm ON cm.id = pmm.canonical_market_id
    JOIN pmci.canonical_events ce ON ce.id = cm.canonical_event_id
    WHERE pmm.removed_at IS NULL
      AND (pmm.status IS NULL OR pmm.status = 'active')
      AND ce.category IN ('sports', 'politics')
    ORDER BY pm.id
  `;
  const params = [];
  if (limit != null && Number.isFinite(limit) && limit > 0) {
    sql += ` LIMIT $1`;
    params.push(limit);
  }
  const { rows } = await client.query(sql, params);

  let moved = 0;
  for (const r of rows) {
    const market = {
      id: String(r.id),
      title: r.title,
      category: r.category,
      provider_market_ref: r.provider_market_ref,
      provider_id: r.provider_id,
      metadata: parseMetadata(r.metadata),
    };
    const { template, params: tparams } = classifyMarketTemplateForSlot(market);
    const newId = await findOrCreateCanonicalMarketSlot(
      client,
      r.canonical_event_id,
      market,
      template,
      tparams,
    );
    if (String(newId) !== String(r.old_cm_id)) {
      moved += 1;
      if (!dry) {
        await client.query(
          `UPDATE pmci.provider_market_map
           SET canonical_market_id = $1::uuid
           WHERE provider_market_id = $2::bigint`,
          [newId, r.id],
        );
        await client.query(
          `UPDATE pmci.provider_markets
           SET market_template = $2, template_params = $3::jsonb
           WHERE id = $1::bigint`,
          [r.id, template, JSON.stringify(tparams ?? {})],
        );
      }
    }
  }
  console.log(
    JSON.stringify(
      {
        dry_run: dry,
        examined: rows.length,
        slots_changed: moved,
      },
      null,
      2,
    ),
  );
} finally {
  await client.end();
}
