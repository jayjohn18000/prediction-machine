#!/usr/bin/env node
/**
 * Backfill title embeddings for pmci.provider_markets using OpenAI + pgvector.
 *
 * Usage:
 *   node scripts/backfill-embeddings.mjs
 *
 * Requirements:
 *   - .env with DATABASE_URL and OPENAI_API_KEY
 */

import pg from "pg";
import { loadEnv } from "../src/platform/env.mjs";
import { embedBatch, toPgVectorLiteral } from "../lib/embeddings.mjs";

const { Client } = pg;

const BATCH_SIZE = 100;

async function main() {
  // Ensure .env is loaded so DATABASE_URL / OPENAI_API_KEY are available.
  loadEnv();

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error("DATABASE_URL is required for backfill-embeddings");
    process.exit(1);
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const countRes = await client.query(
      `SELECT COUNT(*) AS cnt
       FROM pmci.provider_markets
       WHERE title_embedding IS NULL`,
    );
    const totalMissingInitial = Number(countRes.rows?.[0]?.cnt ?? 0);
    if (!Number.isFinite(totalMissingInitial) || totalMissingInitial <= 0) {
      console.log("No provider_markets rows with NULL title_embedding; nothing to backfill.");
      return;
    }

    console.log(
      "Starting embeddings backfill for %d markets (batch size=%d)",
      totalMissingInitial,
      BATCH_SIZE,
    );

    let processed = 0;
    let batchIndex = 0;

    // Important: do NOT use OFFSET against a shrinking WHERE title_embedding IS NULL set.
    // Instead, repeatedly select the next batch of NULL rows until none remain.
    // This ensures we eventually cover all rows even as we update previous batches.
    // Each loop sees the latest snapshot of NULL rows.
    // This is safe because UPDATEs only ever REMOVE rows from the NULL set.
    // (We still track "processed" for logging only.)
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await client.query(
        `SELECT id, title
         FROM pmci.provider_markets
         WHERE title_embedding IS NULL
         ORDER BY id
         LIMIT $1`,
        [BATCH_SIZE],
      );

      const rows = res.rows || [];
      if (rows.length === 0) break;

      const titles = rows.map((r) => r.title || "");
      const vectors = await embedBatch(titles);

      const updates = [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const vec = vectors[i] || [];
        if (!vec.length) continue;
        updates.push({
          id: row.id,
          vecLiteral: toPgVectorLiteral(vec),
        });
      }

      for (const u of updates) {
        await client.query(
          `UPDATE pmci.provider_markets
           SET title_embedding = $1::vector
           WHERE id = $2`,
          [u.vecLiteral, u.id],
        );
      }

      processed += rows.length;
      batchIndex += 1;

      console.log(
        "Batch %d: embedded %d markets (processed=%d / ~%d)",
        batchIndex,
        rows.length,
        processed,
        totalMissingInitial,
      );
    }

    console.log(
      "Backfill complete. Embedded %d markets in %d batches.",
      processed,
      batchIndex,
    );
  } catch (err) {
    console.error("Error during backfill-embeddings:", err && err.message ? err.message : err);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Fatal error in backfill-embeddings:", err && err.message ? err.message : err);
  process.exit(1);
});

