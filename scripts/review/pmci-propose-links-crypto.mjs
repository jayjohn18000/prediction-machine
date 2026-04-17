#!/usr/bin/env node
/**
 * Phase E2 crypto proposer — ladder grouping: match by event_ref first, then strikes.
 * Uses pmci.proposed_links with category `crypto`.
 */
import pg from "pg";
import { loadEnv } from "../../src/platform/env.mjs";
import { cryptoAssetBucket, cryptoPairPrefilter } from "../../lib/matching/compatibility.mjs";
import { tokenize, jaccard } from "../../lib/matching/scoring.mjs";

loadEnv();
const { Client } = pg;

/** Kalshi ladder strike from ticker suffix ...-T74999.99 */
function parseKalshiStrikeFromRef(ref) {
  const m = String(ref || "").match(/-T([\d.]+)\s*$/i);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

/**
 * Polymarket / title fallback: $100,000, $100K, ↑ $150 (often $150K in ladder context).
 */
function parseStrikeFromTitle(title, { allowKShorthand = true } = {}) {
  const t = String(title || "");
  let m = t.match(/\$\s*([\d,]+(?:\.\d+)?)\s*K\b/i);
  if (m) return parseFloat(m[1].replace(/,/g, "")) * 1000;
  m = t.match(/\$\s*([\d,]+(?:\.\d+)?)\b/);
  if (m) {
    let v = parseFloat(m[1].replace(/,/g, ""));
    if (allowKShorthand && v > 0 && v < 1000 && /(bitcoin|btc|ethereum|eth|solana|sol|hit|above|below)/i.test(t)) {
      v *= 1000;
    }
    return v;
  }
  m = t.match(/[↑↓]\s*\$\s*([\d,]+(?:\.\d+)?)/i);
  if (m) {
    let v = parseFloat(m[1].replace(/,/g, ""));
    if (allowKShorthand && v > 0 && v < 1000) v *= 1000;
    return v;
  }
  return null;
}

/** @param {{ title?: string, provider_market_ref?: string }} row @param {'kalshi'|'polymarket'} venue */
function parseStrikeValue(row, venue) {
  if (venue === "kalshi") {
    const fromRef = parseKalshiStrikeFromRef(row.provider_market_ref);
    if (fromRef != null) return fromRef;
  }
  return parseStrikeFromTitle(row.title);
}

function stripDollarThresholds(s) {
  return String(s || "")
    .replace(/\$\s*[\d,]+(?:\.\d+)?\s*K/gi, " ")
    .replace(/\$\s*[\d,]+(?:\.\d+)?/g, " ")
    .replace(/[↑↓]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function eventRefTokens(ref) {
  const base = String(ref || "").split("#")[0];
  return tokenize(base.replace(/-/g, " "));
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
  return stripDollarThresholds(sorted[0]?.title || "");
}

function repMarketId(markets) {
  return Math.min(...markets.map((x) => Number(x.id)));
}

function eventLevelSimilarity(eventRefK, marketsK, eventRefP, marketsP) {
  const titleK = representativeTitle(marketsK);
  const titleP = representativeTitle(marketsP);
  const tokK = new Set([...tokenize(titleK), ...eventRefTokens(eventRefK)]);
  const tokP = new Set([...tokenize(titleP), ...eventRefTokens(eventRefP)]);
  return jaccard(tokK, tokP);
}

function confidenceFromTitleSim(sim) {
  return Math.min(0.85, Math.max(0.5, 0.42 + sim * 0.55));
}

function strikesWithinTolerance(a, b) {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) return false;
  const mx = Math.max(Math.abs(a), Math.abs(b));
  if (mx === 0) return a === b;
  return Math.abs(a - b) / mx < 0.01;
}

/**
 * Best Polymarket group for this Kalshi group: same asset bucket + max title/slug similarity.
 */
function addVolumeToFeatures(k, p, features) {
  return {
    ...features,
    volume_24h_a: k.volume_24h ?? null,
    volume_24h_b: p.volume_24h ?? null,
    volume_24h_combined: ((k.volume_24h ?? 0) + (p.volume_24h ?? 0)) || null,
  };
}

function bestPolyMatch(kEventRef, kMarkets, polyEventMap, kalshiId, polyId) {
  const kRep = kMarkets.slice().sort((a, b) => Number(a.id) - Number(b.id))[0];
  const kBucket = cryptoAssetBucket(`${kRep.title || ""} ${kRep.provider_market_ref || ""}`);
  if (!kBucket) return null;

  let best = null;
  for (const [pEventRef, pMarkets] of polyEventMap) {
    const pRep = pMarkets.slice().sort((a, b) => Number(a.id) - Number(b.id))[0];
    const pBucket = cryptoAssetBucket(`${pRep.title || ""} ${pRep.provider_market_ref || ""}`);
    if (pBucket !== kBucket) continue;

    const pre = cryptoPairPrefilter(
      { ...kRep, provider_id: kalshiId },
      { ...pRep, provider_id: polyId },
    );
    if (!pre.ok) continue;

    const sim = eventLevelSimilarity(kEventRef, kMarkets, pEventRef, pMarkets);
    if (!best || sim > best.sim) best = { pEventRef, pMarkets, sim, pre };
  }
  return best;
}

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
      select id, provider_id, provider_market_ref, event_ref, title, status, close_time, volume_24h
      from pmci.provider_markets
      where provider_id = $1 and ${baseWhere}
      order by id desc
      limit $2
    `,
      [kalshiId, marketCapPerSide],
    );
    const { rows: polyRows } = await client.query(
      `
      select id, provider_id, provider_market_ref, event_ref, title, status, close_time, volume_24h
      from pmci.provider_markets
      where provider_id = $1 and ${baseWhere}
      order by id desc
      limit $2
    `,
      [polyId, marketCapPerSide],
    );

    const kalshiByEvent = groupRowsByEventRef(kalshiRows);
    const polyByEvent = groupRowsByEventRef(polyRows);

    console.log(
      `[pmci:propose:crypto] candidates kalshi=${kalshiRows.length} polymarket=${polyRows.length} (cap ${marketCapPerSide}/side)`,
    );
    console.log(
      `[pmci:propose:crypto] event_groups kalshi=${kalshiByEvent.size} polymarket=${polyByEvent.size}`,
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
    let eventMatches = 0;
    let eventProposals = 0;
    let strikeProposals = 0;

    /** @type {Array<{ k: object, p: object, confidence: number, reasons: object, features: object, kind: 'strike'|'event' }>} */
    const pending = [];

    const MIN_EVENT_SIM = 0.14;

    async function tryInsert(k, p, confidence, reasons, features) {
      if (inserted >= limit) return false;
      const pairKey = `${Math.min(k.id, p.id)}:${Math.max(k.id, p.id)}:equivalent`;
      if (existingPairs.has(pairKey)) return false;

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
      verbose &&
        console.log(
          `[insert] ${reasons.proposal_type} conf=${confidence.toFixed(3)} k=${k.provider_market_ref?.slice(0, 40)} p=${p.provider_market_ref?.slice(0, 40)} ` +
            `volume_24h_a=${features?.volume_24h_a ?? "null"} volume_24h_b=${features?.volume_24h_b ?? "null"} combined=${features?.volume_24h_combined ?? "null"}`,
        );
      return true;
    }

    function enqueue(k, p, confidence, reasons, features, kind) {
      pending.push({
        k,
        p,
        confidence,
        reasons,
        features: addVolumeToFeatures(k, p, features),
        kind,
      });
    }

    for (const [kEventRef, kMarkets] of kalshiByEvent) {
      considered += polyByEvent.size;
      const match = bestPolyMatch(kEventRef, kMarkets, polyByEvent, kalshiId, polyId);
      if (!match || match.sim < MIN_EVENT_SIM) {
        rejected += 1;
        verbose &&
          console.log(
            `[skip] no_poly_match event=${kEventRef.slice(0, 48)} sim=${match ? match.sim.toFixed(3) : "n/a"}`,
          );
        continue;
      }

      const { pEventRef, pMarkets, sim, pre } = match;
      eventMatches += 1;

      const titleK = representativeTitle(kMarkets);
      const titleP = representativeTitle(pMarkets);
      const eventTitleK = kMarkets.slice().sort((a, b) => Number(a.id) - Number(b.id))[0]?.title || "";
      const eventTitleP = pMarkets.slice().sort((a, b) => Number(a.id) - Number(b.id))[0]?.title || "";

      const repK = kMarkets.find((m) => Number(m.id) === repMarketId(kMarkets));
      const repP = pMarkets.find((m) => Number(m.id) === repMarketId(pMarkets));

      const multiLadder = kMarkets.length > 1 || pMarkets.length > 1;

      /** @type {Array<{ k: object, p: object, sk: number|null, sp: number|null }>} */
      const strikePairs = [];
      for (const k of kMarkets) {
        const sk = parseStrikeValue(k, "kalshi");
        for (const p of pMarkets) {
          considered += 1;
          const sp = parseStrikeValue(p, "polymarket");
          if (strikesWithinTolerance(sk, sp)) strikePairs.push({ k, p, sk, sp });
        }
      }

      const confEvent = confidenceFromTitleSim(sim);

      if (!multiLadder) {
        const one = strikePairs[0];
        if (one && one.sk != null && one.sp != null) {
          const confidence = Math.max(0.75, confEvent);
          const reasons = {
            proposal_type: "strike_match",
            event_ref_k: kEventRef,
            event_ref_p: pEventRef,
            title_similarity: Math.round(sim * 10000) / 10000,
            asset_gate: pre,
            source: "crypto_proposer_v2_ladder",
          };
          const features = {
            strike_value_k: one.sk,
            strike_value_p: one.sp,
            event_title_k: eventTitleK,
            event_title_p: eventTitleP,
            title_k: one.k.title,
            title_p: one.p.title,
          };
          enqueue(one.k, one.p, confidence, reasons, features, "strike");
        } else {
          const reasons = {
            proposal_type: "event_group",
            event_ref_k: kEventRef,
            event_ref_p: pEventRef,
            title_similarity: Math.round(sim * 10000) / 10000,
            asset_gate: pre,
            source: "crypto_proposer_v2_ladder",
          };
          const features = {
            event_title_k: eventTitleK,
            event_title_p: eventTitleP,
            title_k: repK.title,
            title_p: repP.title,
          };
          enqueue(repK, repP, confEvent, reasons, features, "event");
        }
        continue;
      }

      {
        const reasons = {
          proposal_type: "event_group",
          event_ref_k: kEventRef,
          event_ref_p: pEventRef,
          title_similarity: Math.round(sim * 10000) / 10000,
          asset_gate: pre,
          source: "crypto_proposer_v2_ladder",
        };
        const features = {
          event_title_k: eventTitleK,
          event_title_p: eventTitleP,
          title_k: repK.title,
          title_p: repP.title,
        };
        enqueue(repK, repP, confEvent, reasons, features, "event");
      }

      for (const { k, p, sk, sp } of strikePairs) {
        if (Number(k.id) === Number(repK.id) && Number(p.id) === Number(repP.id)) continue;

        const confidence = Math.max(0.75, confEvent);
        const reasons = {
          proposal_type: "strike_match",
          event_ref_k: kEventRef,
          event_ref_p: pEventRef,
          title_similarity: Math.round(sim * 10000) / 10000,
          asset_gate: pre,
          source: "crypto_proposer_v2_ladder",
        };
        const features = {
          strike_value_k: sk,
          strike_value_p: sp,
          event_title_k: eventTitleK,
          event_title_p: eventTitleP,
          title_k: k.title,
          title_p: p.title,
        };
        enqueue(k, p, confidence, reasons, features, "strike");
      }
    }

    pending.sort((a, b) => {
      const va = a.features?.volume_24h_combined ?? 0;
      const vb = b.features?.volume_24h_combined ?? 0;
      return vb - va;
    });

    for (const item of pending) {
      if (inserted >= limit) break;
      const ok = await tryInsert(item.k, item.p, item.confidence, item.reasons, item.features);
      if (ok) {
        if (item.kind === "strike") strikeProposals += 1;
        else eventProposals += 1;
      }
    }

    console.log(
      `pmci:propose:crypto considered=${considered} inserted=${inserted} rejected=${rejected} ` +
        `event_matches=${eventMatches} event_proposals=${eventProposals} strike_proposals=${strikeProposals} ` +
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
