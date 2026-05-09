#!/usr/bin/env node
import process from "node:process";

import { createPgClient } from "../../lib/mm/order-store.mjs";
import { writeWeeklyDigest } from "../../lib/scanner/weekly-digest-render.mjs";
import { loadEnv } from "../../src/platform/env.mjs";

loadEnv();

const idx = process.argv.indexOf("--week");
const week = idx !== -1 ? process.argv[idx + 1] : undefined;
const skipRetire = process.argv.includes("--skip-auto-retire");

const client = createPgClient();
await client.connect();
try {
  const out = await writeWeeklyDigest({
    client,
    weekStamp: week,
    skipAutoRetire: skipRetire,
  });
  console.log(JSON.stringify({ ok: true, ...out }));
} catch (e) {
  console.error(e);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
