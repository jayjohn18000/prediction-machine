#!/usr/bin/env node
/**
 * Backfill pmci.provider_markets.market_template + template_params (Phase E4).
 * Rule-based first; Haiku batch for remainder.
 */
import pg from "pg";
import { loadEnv } from "../../src/platform/env.mjs";
import { classifyTemplate } from "../../lib/matching/templates/index.mjs";
import { classifyBatch } from "../../lib/matching/templates/llm-classifier.mjs";

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
  const maxBatches = (() => {
    const i = argv.indexOf("--max-batches");
    if (i >= 0) return Math.max(1, Number(argv[i + 1] || 1));
    return null;
  })();

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  const stats = {
    total: 0,
    rule_classified: 0,
    llm_classified: 0,
    unclassified: 0,
    batches: 0,
  };

  try {
    let batchNum = 0;
    while (true) {
      if (maxBatches != null && batchNum >= maxBatches) break;

      const { rows } = await client.query(
        `SELECT id, title, provider_market_ref, category, provider_id
         FROM pmci.provider_markets
         WHERE market_template IS NULL
         ORDER BY id
         LIMIT $1`,
        [BATCH],
      );

      if (!rows.length) break;
      stats.batches += 1;
      batchNum += 1;

      const ruleUpdates = [];
      const needLlm = [];

      for (const row of rows) {
        stats.total += 1;
        const hit = classifyTemplate(row);
        if (hit) {
          stats.rule_classified += 1;
          ruleUpdates.push({ id: row.id, template: hit.template, params: hit.params || {} });
        } else {
          needLlm.push(row);
        }
      }

      for (const u of ruleUpdates) {
        await client.query(
          `UPDATE pmci.provider_markets SET market_template = $2, template_params = $3::jsonb WHERE id = $1`,
          [u.id, u.template, JSON.stringify(u.params)],
        );
      }

      if (needLlm.length > 0) {
        const llmOut = await classifyBatch(
          needLlm.map((r) => ({
            id: r.id,
            title: r.title,
            category: r.category,
            provider_market_ref: r.provider_market_ref,
            provider_id: r.provider_id,
          })),
        );

        for (const r of llmOut) {
          if (r.template === "unclassified") {
            stats.unclassified += 1;
            await client.query(
              `UPDATE pmci.provider_markets SET market_template = $2, template_params = $3::jsonb WHERE id = $1`,
              [r.id, null, JSON.stringify(r.params || {})],
            );
          } else {
            stats.llm_classified += 1;
            await client.query(
              `UPDATE pmci.provider_markets SET market_template = $2, template_params = $3::jsonb WHERE id = $1`,
              [r.id, r.template, JSON.stringify(r.params || {})],
            );
          }
        }
      }

      console.log(JSON.stringify({ ...stats, batch_rows: rows.length }));
    }

    console.log("pmci:classify:templates done", JSON.stringify(stats));
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
