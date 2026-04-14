#!/usr/bin/env node
/**
 * Phase E3 economics proposer — guard-first: macro keyword overlap on titles + refs.
 */
import pg from "pg";
import { loadEnv } from "../../src/platform/env.mjs";

loadEnv();
const { Client } = pg;

const MACRO_RE = /(fed|fomc|cpi|nfp|rate cut|interest rate|jobs report|unemployment|gdp|inflation|powell|recession)/gi;

function macroTokens(row) {
  const s = `${row.title || ""} ${row.provider_market_ref || ""} ${row.event_ref || ""}`;
  const out = new Set();
  for (const m of s.matchAll(MACRO_RE)) {
    if (m[1]) out.add(m[1].toLowerCase());
  }
  return out;
}

function tokenOverlap(a, b) {
  for (const t of a) if (b.has(t)) return t;
  return null;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const limitIdx = argv.indexOf("--limit");
  const limit = limitIdx >= 0 ? Math.max(1, Number(argv[limitIdx + 1] || 0)) : 60;
  const capIdx = argv.indexOf("--market-cap");
  const marketCapPerSide = capIdx >= 0
    ? Math.max(20, Number(argv[capIdx + 1] || 0))
    : Math.max(20, Number(process.env.PMCI_PROPOSE_ECON_MARKETS_PER_SIDE || 500));

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const providers = await client.query(
      `select id, code from pmci.providers where code in ('kalshi','polymarket') order by code`,
    );
    const byCode = new Map(providers.rows.map((r) => [r.code, r.id]));
    const kalshiId = Number(byCode.get("kalshi"));
    const polyId = Number(byCode.get("polymarket"));

    const where = `category = 'economics' and coalesce(status,'') in ('active','open')`;

    const { rows: kalshiRows } = await client.query(
      `select id, provider_id, provider_market_ref, event_ref, title from pmci.provider_markets
       where provider_id = $1 and ${where} order by id desc limit $2`,
      [kalshiId, marketCapPerSide],
    );
    const { rows: polyRows } = await client.query(
      `select id, provider_id, provider_market_ref, event_ref, title from pmci.provider_markets
       where provider_id = $1 and ${where} order by id desc limit $2`,
      [polyId, marketCapPerSide],
    );

    console.log(
      `[pmci:propose:economics] candidates kalshi=${kalshiRows.length} polymarket=${polyRows.length}`,
    );

    const existing = await client.query(
      `select provider_market_id_a, provider_market_id_b, proposed_relationship_type from pmci.proposed_links where category = 'economics'`,
    );
    const existingPairs = new Set(
      existing.rows.map(
        (r) =>
          `${Math.min(r.provider_market_id_a, r.provider_market_id_b)}:${Math.max(r.provider_market_id_a, r.provider_market_id_b)}:${r.proposed_relationship_type}`,
      ),
    );

    let inserted = 0;
    let considered = 0;

    for (const k of kalshiRows) {
      if (inserted >= limit) break;
      const kt = macroTokens(k);
      if (kt.size === 0) continue;
      for (const p of polyRows) {
        if (inserted >= limit) break;
        considered += 1;
        const pt = macroTokens(p);
        const overlap = tokenOverlap(kt, pt);
        if (!overlap) continue;
        const pairKey = `${Math.min(k.id, p.id)}:${Math.max(k.id, p.id)}:equivalent`;
        if (existingPairs.has(pairKey)) continue;

        if (!dryRun) {
          await client.query(
            `insert into pmci.proposed_links (
              category, provider_market_id_a, provider_market_id_b, proposed_relationship_type, confidence, reasons, features
            ) values ('economics', $1, $2, 'equivalent', $3, $4::jsonb, $5::jsonb)
             on conflict do nothing`,
            [
              Math.min(k.id, p.id),
              Math.max(k.id, p.id),
              0.5,
              JSON.stringify({ macro_overlap: overlap, source: "economics_proposer_v1" }),
              JSON.stringify({}),
            ],
          );
        }
        existingPairs.add(pairKey);
        inserted += 1;
      }
    }

    console.log(
      `pmci:propose:economics considered=${considered} inserted=${inserted} limit=${limit}${dryRun ? " dry-run=true" : ""}`,
    );
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
