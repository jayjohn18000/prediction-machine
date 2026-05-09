#!/usr/bin/env node
import process from "node:process";

import { createPgClient } from "../../lib/mm/order-store.mjs";
import { runAlertDeliveryRound } from "../../lib/scanner/alert-delivery.mjs";
import { loadEnv } from "../../src/platform/env.mjs";

loadEnv();

async function one() {
  const client = createPgClient();
  await client.connect();
  try {
    const out = await runAlertDeliveryRound(client);
    console.log(JSON.stringify({ ok: true, ...out }));
    if (out.failed > 0 || out.errors.length > 0) {
      process.exitCode = 2;
    }
  } finally {
    await client.end().catch(() => {});
  }
}

const daemon = process.argv.includes("--daemon");
if (!daemon) {
  await one();
  process.exit(process.exitCode ?? 0);
}

let stop = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    stop = true;
  });
}

console.error("[alert-delivery-worker] daemon; 60s tick; graceful shutdown on SIGTERM/SIGINT");
while (!stop) {
  await one().catch((e) => console.error(e));
  await new Promise((r) => setTimeout(r, 60_000));
}
