#!/usr/bin/env node
/**
 * Phase E3/E4 economics proposer — group by event_ref, match event groups across venues,
 * then propose equivalent links at event level (same pattern as crypto ladder proposer).
 */
import pg from "pg";
import { loadEnv } from "../../src/platform/env.mjs";
import { areTemplatesCompatible } from "../../lib/matching/templates/compatibility-rules.mjs";
import { tokenize, jaccard } from "../../lib/matching/scoring.mjs";

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

/** Coarse bucket so unrelated macro topics are not cross-matched. */
function econTopicBucket(row) {
  const t = macroTokens(row);
  if (t.has("fed") || t.has("fomc") || t.has("powell") || t.has("rate cut") || t.has("interest rate")) {
    return "fed_monetary";
  }
  if (t.has("cpi") || t.has("inflation")) return "inflation_cpi";
  if (t.has("nfp") || t.has("jobs report") || t.has("unemployment")) return "employment";
  if (t.has("gdp") || t.has("recession")) return "growth";
  if (t.size === 0) return null;
  return `macro:${[...t].sort().join("+")}`;
}

function tokenOverlap(a, b) {
  for (const x of a) if (b.has(x)) return x;
  return null;
}

function templateParams(row) {
  const p = row?.template_params;
  if (p && typeof p === "object") return p;
  return {};
}

function groupRowsByEventRef(rows) {
  const m = new Map();
  for (const r of rows) {
    const key = String(r.event_ref || "").trim() || `__singleton_${r.id}__`;
    if (!m.has(key)) m.set(key, []);
    m.get(key).push(r);
  }
  return m;
}

function representativeTitle(markets) {
  const sorted = [...markets].sort((a, b) => Number(a.id) - Number(b.id));
  return String(sorted[0]?.title || "");
}

function repMarket(markets) {
  return [...markets].sort((a, b) => Number(a.id) - Number(b.id))[0];
}

function eventRefTokens(ref) {
  return tokenize(String(ref || "").split("#")[0].replace(/-/g, " "));
}

function eventLevelSimilarity(eventRefK, marketsK, eventRefP, marketsP) {
  const titleK = representativeTitle(marketsK);
  const titleP = representativeTitle(marketsP);
  const tokK = new Set([...tokenize(titleK), ...eventRefTokens(eventRefK)]);
  const tokP = new Set([...tokenize(titleP), ...eventRefTokens(eventRefP)]);
  return jaccard(tokK, tokP);
}

function confidenceFromTitleSim(sim) {
  return Math.min(0.92, Math.max(0.45, 0.4 + sim * 0.55));
}

function templateGate(k, p) {
  if (!k?.market_template || !p?.market_template) {
    return { compatible: true, reason: "legacy_missing_template" };
  }
  return areTemplatesCompatible(
    k.market_template,
    templateParams(k),
    p.market_template,
    templateParams(p),
  );
}

const MIN_EVENT_SIM = 0.14;

function bestPolyEventGroup(kEventRef, kMarkets, polyByEvent, verbose) {
  const kRep = repMarket(kMarkets);
  const kBucket = econTopicBucket(kRep);
  if (!kBucket) return null;

  let best = null;
  for (const [pEventRef, pMarkets] of polyByEvent) {
    const pRep = repMarket(pMarkets);
    const pBucket = econTopicBucket(pRep);
    if (pBucket !== kBucket) continue;

    const tg = templateGate(kRep, pRep);
    if (!tg.compatible) continue;

    if (kRep.market_template && pRep.market_template) {
      /* already gated */
    } else {
      const kt = macroTokens(kRep);
      const pt = macroTokens(pRep);
      if (!tokenOverlap(kt, pt)) continue;
    }

    const sim = eventLevelSimilarity(kEventRef, kMarkets, pEventRef, pMarkets);
    if (!best || sim > best.sim) best = { pEventRef, pMarkets, sim, kRep, pRep, tg };
  }

  if (verbose && !best) {
    console.log(`[pmci:propose:economics] no_poly_match event=${String(kEventRef).slice(0, 48)} bucket=${kBucket}`);
  }
  return best;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const verbose = argv.includes("--verbose");
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
      `select id, provider_id, provider_market_ref, event_ref, title, status, close_time, volume_24h,
              market_template, template_params
       from pmci.provider_markets
       where provider_id = $1 and ${where} order by id desc limit $2`,
      [kalshiId, marketCapPerSide],
    );
    const { rows: polyRows } = await client.query(
      `select id, provider_id, provider_market_ref, event_ref, title, status, close_time, volume_24h,
              market_template, template_params
       from pmci.provider_markets
       where provider_id = $1 and ${where} order by id desc limit $2`,
      [polyId, marketCapPerSide],
    );

    const kalshiByEvent = groupRowsByEventRef(kalshiRows);
    const polyByEvent = groupRowsByEventRef(polyRows);

    console.log(
      `[pmci:propose:economics] candidates kalshi=${kalshiRows.length} polymarket=${polyRows.length} ` +
        `event_groups kalshi=${kalshiByEvent.size} polymarket=${polyByEvent.size}`,
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
    let eventMatches = 0;

    /** @type {Array<{ k: object, p: object, confidence: number, reasons: object, features: object }>} */
    const pending = [];

    for (const [kEventRef, kMarkets] of kalshiByEvent) {
      considered += polyByEvent.size;
      const match = bestPolyEventGroup(kEventRef, kMarkets, polyByEvent, verbose);
      if (!match || match.sim < MIN_EVENT_SIM) continue;

      eventMatches += 1;
      const { pEventRef, pMarkets, sim, kRep, pRep } = match;

      const confidence = confidenceFromTitleSim(sim);
      const titleK = representativeTitle(kMarkets);
      const titleP = representativeTitle(pMarkets);
      const reasons = {
        proposal_type: "event_group",
        source: "economics_proposer_v3_event_group",
        title_similarity: Math.round(sim * 10000) / 10000,
        event_ref_k: kEventRef,
        event_ref_p: pEventRef,
        econ_topic_bucket: econTopicBucket(kRep),
        templates: { k: kRep.market_template, p: pRep.market_template },
      };
      const features = {
        event_title_k: titleK,
        event_title_p: titleP,
        title_k: kRep.title,
        title_p: pRep.title,
        volume_24h_a: kRep.volume_24h ?? null,
        volume_24h_b: pRep.volume_24h ?? null,
        volume_24h_combined: ((kRep.volume_24h ?? 0) + (pRep.volume_24h ?? 0)) || null,
      };
      pending.push({ k: kRep, p: pRep, confidence, reasons, features });
    }

    pending.sort((a, b) => {
      const va = a.features?.volume_24h_combined ?? 0;
      const vb = b.features?.volume_24h_combined ?? 0;
      return vb - va;
    });

    for (const item of pending) {
      if (inserted >= limit) break;
      const { k, p, confidence, reasons, features } = item;
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
            confidence,
            JSON.stringify(reasons),
            JSON.stringify(features),
          ],
        );
      }
      existingPairs.add(pairKey);
      inserted += 1;
      if (verbose) {
        console.log(
          `[insert] event_group conf=${confidence.toFixed(3)} k=${k.provider_market_ref?.slice(0, 40)} p=${p.provider_market_ref?.slice(0, 40)}`,
        );
      }
    }

    console.log(
      `pmci:propose:economics considered=${considered} inserted=${inserted} event_matches=${eventMatches} ` +
        `limit=${limit}${dryRun ? " dry-run=true" : ""}`,
    );
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
