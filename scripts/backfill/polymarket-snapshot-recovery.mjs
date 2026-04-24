#!/usr/bin/env node
/**
 * Runner: backfill Polymarket snapshots for every bilateral pmid with
 * fewer than --min-snapshots existing rows.
 *
 * Usage:
 *   node scripts/backfill/polymarket-snapshot-recovery.mjs
 *   node scripts/backfill/polymarket-snapshot-recovery.mjs --min-snapshots 10 --dry-run
 *
 * Emits one line per pmid: pmid | title | tokenId | fetched | inserted | dupes-skipped.
 * Exit status: 0 on any successful run (even partial). Non-zero only on
 * fatal DB / config errors.
 */
import "dotenv/config";
import pg from "pg";
import {
  backfillOnePmid,
  loadPolymarketBackfillCandidates,
} from "../../lib/backfill/polymarket-snapshot-recovery.mjs";

function parseArgs(argv) {
  const out = { minSnapshots: 10, dryRun: false, limit: null, sleepMs: 150 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--min-snapshots") out.minSnapshots = Number(argv[++i]);
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a === "--sleep-ms") out.sleepMs = Number(argv[++i]);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    statement_timeout: 30000,
  });
  await client.connect();

  const candidates = await loadPolymarketBackfillCandidates(client, {
    minSnapshots: args.minSnapshots,
  });

  const workable = candidates.filter((c) => c.yesTokenId);
  const missingToken = candidates.filter((c) => !c.yesTokenId);

  console.log(
    `[backfill] candidates: ${candidates.length} (workable: ${workable.length}, missing token: ${missingToken.length}) — threshold < ${args.minSnapshots} snapshots`,
  );
  if (missingToken.length) {
    for (const m of missingToken) {
      console.log(`  [skip] pmid=${m.pmid} has no clob_token_ids in metadata — needs re-ingestion. title="${m.title}"`);
    }
  }

  const queue = args.limit ? workable.slice(0, args.limit) : workable;
  if (args.dryRun) {
    console.log("[backfill] --dry-run: listing candidates only, no API calls");
    for (const c of queue) {
      console.log(`  pmid=${c.pmid} existing=${c.currentSnapshots} token=${c.yesTokenId.slice(0, 16)}… title="${c.title.slice(0, 70)}"`);
    }
    await client.end();
    return;
  }

  let totalInserted = 0;
  let failed = 0;
  for (const c of queue) {
    try {
      const r = await backfillOnePmid({
        pg: client,
        providerMarketId: c.pmid,
        yesTokenId: c.yesTokenId,
      });
      totalInserted += r.inserted;
      console.log(
        `pmid=${c.pmid} existing=${c.currentSnapshots} fetched=${r.fetched} inserted=${r.inserted} degenerate=${r.skippedDegenerate} title="${c.title.slice(0, 60)}"`,
      );
    } catch (err) {
      failed += 1;
      console.error(`pmid=${c.pmid} ERROR: ${err?.message || err}`);
    }
    if (args.sleepMs > 0) await new Promise((res) => setTimeout(res, args.sleepMs));
  }

  console.log(`[backfill] done. pmids_processed=${queue.length} inserted_total=${totalInserted} failures=${failed}`);
  await client.end();
  if (failed > 0 && totalInserted === 0) process.exit(1);
}

main().catch((err) => {
  console.error("[backfill] fatal:", err);
  process.exit(2);
});
