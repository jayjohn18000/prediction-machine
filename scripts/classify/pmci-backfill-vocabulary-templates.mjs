#!/usr/bin/env node
/**
 * Writes pmci.provider_markets.market_template + template_params from
 * lib/classification/vocabulary-market-template.mjs (same rules as export-vocabulary-classification).
 *
 * Use when DB columns should match the vocabulary classifier (richer than rule-only sports-templates).
 * Ingest still uses lib/matching/templates/index.mjs for crypto/economics/sports bucket rules unless
 * you extend that path separately.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/classify/pmci-backfill-vocabulary-templates.mjs [--dry-run] [--max-batches N]
 *
 * Default: only updates rows where market_template IS NULL (same spirit as pmci-classify-templates).
 *   --all-rows   Re-classify every row (can set market_template to NULL where rules miss — use with care).
 */
import pg from "pg";
import { loadEnv } from "../../src/platform/env.mjs";
import { classifyVocabularyTemplate } from "../../lib/classification/vocabulary-market-template.mjs";

loadEnv();
const { Client } = pg;

const BATCH = 500;

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const allRows = argv.includes("--all-rows");
  const maxBatches = (() => {
    const i = argv.indexOf("--max-batches");
    if (i >= 0) return Math.max(1, Number(argv[i + 1] || 1));
    return null;
  })();

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  let rowsSeen = 0;
  let rowsUpdated = 0;
  let batchNum = 0;
  let lastId = 0;

  const nullOnlyWhere = allRows ? "" : "AND market_template IS NULL";

  try {
    while (true) {
      if (maxBatches != null && batchNum >= maxBatches) break;

      const { rows } = await client.query(
        `SELECT id, provider_id, provider_market_ref, event_ref, title, category, status, sport, event_type, game_date, close_time, home_team, away_team
         FROM pmci.provider_markets
         WHERE id > $1 ${nullOnlyWhere}
         ORDER BY id ASC
         LIMIT $2`,
        [lastId, BATCH],
      );

      if (!rows.length) break;
      batchNum += 1;

      for (const row of rows) {
        lastId = Number(row.id);
        rowsSeen += 1;
        const out = classifyVocabularyTemplate(row);
        const tpl = out.market_template;
        const params = out.template_params ?? {};
        const shouldWrite = allRows || tpl != null;
        if (!shouldWrite) continue;

        if (!dryRun) {
          await client.query(
            `UPDATE pmci.provider_markets
             SET market_template = $2,
                 template_params = $3::jsonb
             WHERE id = $1`,
            [row.id, tpl, JSON.stringify(params)],
          );
        }
        rowsUpdated += 1;
      }
    }

    console.log(
      JSON.stringify(
        {
          dry_run: dryRun,
          all_rows: allRows,
          rows_seen: rowsSeen,
          rows_updated: rowsUpdated,
          batches: batchNum,
          note: "classification_confidence from vocabulary is not stored in DB (only template + params)",
        },
        null,
        2,
      ),
    );
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
