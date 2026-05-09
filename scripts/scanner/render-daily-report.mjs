#!/usr/bin/env node
import process from "node:process";

import { createPgClient } from "../../lib/mm/order-store.mjs";
import { writeDailyReport } from "../../lib/scanner/daily-report-render.mjs";
import { loadEnv } from "../../src/platform/env.mjs";

loadEnv();

const date =
  process.argv.indexOf("--date") !== -1
    ? process.argv[process.argv.indexOf("--date") + 1]
    : undefined;

const client = createPgClient();
await client.connect();
try {
  const out = await writeDailyReport({ client, dateStamp: date });
  console.log(JSON.stringify({ ok: true, ...out }));
} catch (e) {
  console.error(e);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
