#!/usr/bin/env node
/**
 * PMCI watch: poll /v1/health/freshness until stale/error persists.
 * Usage (API must be running):
 *   node scripts/pmci-watch.mjs [baseUrl] [intervalSec] [maxStaleChecks]
 * Defaults: baseUrl=http://localhost:8787, intervalSec=30, maxStaleChecks=4.
 */

const baseUrl = process.argv[2] || "http://localhost:8787";
const intervalSec = Number(process.argv[3] || "30");
const maxStaleChecks = Number(process.argv[4] || "4");

let consecutiveBad = 0;

async function tick() {
  try {
    const res = await fetch(`${baseUrl}/v1/health/freshness`);
    if (!res.ok) {
      console.error("pmci:watch health HTTP", res.status, await res.text());
      consecutiveBad += 1;
    } else {
      const body = await res.json();
      const status = body.status;
      const lag = body.lag_seconds;
      console.log(
        "pmci:watch status=%s lag=%s counts=%j",
        status,
        lag,
        body.counts || {}
      );
      if (status === "ok") {
        consecutiveBad = 0;
      } else {
        consecutiveBad += 1;
      }
    }
  } catch (err) {
    console.error("pmci:watch error", err.message);
    consecutiveBad += 1;
  }

  if (consecutiveBad > maxStaleChecks) {
    console.error(
      "pmci:watch exiting non-zero: status not ok for %d consecutive checks",
      consecutiveBad
    );
    process.exit(1);
  }

  setTimeout(tick, intervalSec * 1000);
}

tick();

