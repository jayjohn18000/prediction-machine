/**
 * Entry for pg_cron / admin job → `backfillPostFillMids`.
 */

import { createPgClient } from "./order-store.mjs";
import { backfillPostFillMids } from "./post-fill-backfill.mjs";

/**
 * @param {{ now?: Date, connectionString?: string }} [opts]
 */
export async function runPostFillBackfillCron(opts = {}) {
  const client = createPgClient(opts.connectionString ?? process.env.DATABASE_URL?.trim());
  await client.connect();
  try {
    return await backfillPostFillMids({ client, now: opts.now ?? new Date() });
  } finally {
    await client.end().catch(() => {});
  }
}
