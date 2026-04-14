#!/usr/bin/env node
/**
 * Phase E2 crypto proposer — guard-first: same asset bucket (BTC/ETH/SOL) before scoring.
 * Uses pmci.proposed_links with category `crypto`.
 */
import pg from "pg";
import { loadEnv } from "../../src/platform/env.mjs";
import { cryptoPairPrefilter } from "../../lib/matching/compatibility.mjs";

loadEnv();
const { Client } = pg;

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const verbose = argv.includes("--verbose");
  const limitIdx = argv.indexOf("--limit");
  const limit = limitIdx >= 0 ? Math.max(1, Number(argv[limitIdx + 1] || 0)) : 80;
  const capIdx = argv.indexOf("--market-cap");
  const marketCapPerSide = capIdx >= 0
    ? Math.max(20, Number(argv[capIdx + 1] || 0))
    : Math.max(20, Number(process.env.PMCI_PROPOSE_CRYPTO_MARKETS_PER_SIDE || 400));

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const providers = await client.query(
      `select id, code from pmci.providers where code in ('kalshi','polymarket') order by code`,
    );
    const byCode = new Map(providers.rows.map((r) => [r.code, r.id]));
    const kalshiId = Number(byCode.get("kalshi"));
    const polyId = Number(byCode.get("polymarket"));

    const baseWhere = `
      category = 'crypto'
        and coalesce(status,'') in ('active','open')`;

    const { rows: kalshiRows } = await client.query(
      `
      select id, provider_id, provider_market_ref, event_ref, title, status, close_time
      from pmci.provider_markets
      where provider_id = $1 and ${baseWhere}
      order by id desc
      limit $2
    `,
      [kalshiId, marketCapPerSide],
    );
    const { rows: polyRows } = await client.query(
      `
      select id, provider_id, provider_market_ref, event_ref, title, status, close_time
      from pmci.provider_markets
      where provider_id = $1 and ${baseWhere}
      order by id desc
      limit $2
    `,
      [polyId, marketCapPerSide],
    );

    console.log(
      `[pmci:propose:crypto] candidates kalshi=${kalshiRows.length} polymarket=${polyRows.length} (cap ${marketCapPerSide}/side)`,
    );

    const existing = await client.query(`
      select provider_market_id_a, provider_market_id_b, proposed_relationship_type
      from pmci.proposed_links
      where category = 'crypto'
    `);
    const existingPairs = new Set(
      existing.rows.map(
        (r) =>
          `${Math.min(r.provider_market_id_a, r.provider_market_id_b)}:${Math.max(r.provider_market_id_a, r.provider_market_id_b)}:${r.proposed_relationship_type}`,
      ),
    );

    let inserted = 0;
    let considered = 0;
    let rejected = 0;

    for (const k of kalshiRows) {
      if (inserted >= limit) break;
      for (const p of polyRows) {
        if (inserted >= limit) break;
        considered += 1;
        const pre = cryptoPairPrefilter(k, p);
        if (!pre.ok) {
          rejected += 1;
          verbose && console.log(`[skip] ${pre.reason}`);
          continue;
        }
        const pairKey = `${Math.min(k.id, p.id)}:${Math.max(k.id, p.id)}:equivalent`;
        if (existingPairs.has(pairKey)) continue;

        const confidence = 0.55;
        const reasons = {
          asset_gate: pre,
          source: "crypto_proposer_v1",
        };
        const features = { title_k: k.title, title_p: p.title };

        if (!dryRun) {
          await client.query(
            `insert into pmci.proposed_links (
              category, provider_market_id_a, provider_market_id_b, proposed_relationship_type, confidence, reasons, features
            ) values ('crypto', $1, $2, 'equivalent', $3, $4::jsonb, $5::jsonb)
             on conflict do nothing`,
            [Math.min(k.id, p.id), Math.max(k.id, p.id), confidence, JSON.stringify(reasons), JSON.stringify(features)],
          );
        }
        existingPairs.add(pairKey);
        inserted += 1;
      }
    }

    console.log(
      `pmci:propose:crypto considered=${considered} inserted=${inserted} rejected=${rejected} limit=${limit}${dryRun ? " dry-run=true" : ""}`,
    );
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
