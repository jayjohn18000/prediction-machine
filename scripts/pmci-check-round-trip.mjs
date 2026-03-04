#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const { Client } = pg;

function loadEnv() {
  const envPath = path.join(process.cwd(), ".env");
  try {
    const env = fs.readFileSync(envPath, "utf8");
    env.split("\n").forEach((line) => {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    });
  } catch {
    // ignore missing .env
  }
}

loadEnv();

const MAX_LAG_SECONDS = Number(process.env.PMCI_MAX_LAG_SECONDS ?? "180");
const API_BASE = process.env.PMCI_API_URL?.trim() || "http://localhost:8787";

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error("ERROR: DATABASE_URL is required. Set it in .env");
    process.exit(1);
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  let hardFail = false;
  let hadWarnings = false;

  try {
    // Step 1: Find a recently accepted proposal
    const propRes = await client.query(
      `SELECT pl.id, pl.accepted_family_id, pl.provider_market_id_a, pl.provider_market_id_b,
              pl.reviewed_at, pl.accepted_relationship_type, pl.confidence
       FROM pmci.proposed_links pl
       WHERE pl.decision = 'accepted'
         AND pl.accepted_family_id IS NOT NULL
       ORDER BY pl.reviewed_at DESC
       LIMIT 1`,
    );

    if (propRes.rowCount === 0) {
      console.log(
        "SKIP: No accepted proposals found. Run: npm run pmci:propose:politics, then accept one via npm run pmci:review",
      );
      return;
    }

    const pl = propRes.rows[0];
    const familyId = Number(pl.accepted_family_id);
    const idA = Number(pl.provider_market_id_a);
    const idB = Number(pl.provider_market_id_b);
    console.log(
      `✓ Found accepted proposal id=${pl.id} → family_id=${familyId} (accepted at ${pl.reviewed_at})`,
    );

    // Step 2: Verify family has active links in v_market_links_current
    const linksRes = await client.query(
      `SELECT provider_market_id, provider_market_ref, provider
       FROM pmci.v_market_links_current
       WHERE family_id = $1`,
      [familyId],
    );

    if (linksRes.rowCount === 0) {
      console.error(
        `FAIL: family_id=${familyId} not found in v_market_links_current. Links may not have been created correctly.`,
      );
      hardFail = true;
      return;
    }

    if (linksRes.rowCount < 2) {
      console.warn(
        `WARN: family_id=${familyId} has only ${linksRes.rowCount} active link(s). Expected 2 (one per provider).`,
      );
      hadWarnings = true;
    } else {
      console.log(
        `✓ family_id=${familyId} has ${linksRes.rowCount} active links in v_market_links_current`,
      );
    }

    const linkedMarketIds = [];
    const linkedMarketRefs = new Map();
    for (const row of linksRes.rows) {
      const mid = Number(row.provider_market_id);
      linkedMarketIds.push(mid);
      linkedMarketRefs.set(mid, row.provider_market_ref);
      console.log(
        `   - ${row.provider}: ${row.provider_market_ref} (market_id=${mid})`,
      );
    }

    // Step 3: Check snapshots exist for linked markets
    const snapsRes = await client.query(
      `SELECT provider_market_id, MAX(observed_at) AS latest, COUNT(*)::int AS total
       FROM pmci.provider_market_snapshots
       WHERE provider_market_id = ANY($1)
       GROUP BY provider_market_id`,
      [linkedMarketIds],
    );

    const nowMs = Date.now();
    const snapsById = new Map(
      (snapsRes.rows || []).map((r) => [Number(r.provider_market_id), r]),
    );

    for (const mid of linkedMarketIds) {
      const ref = linkedMarketRefs.get(mid);
      const row = snapsById.get(mid);
      if (!row) {
        console.warn(
          `WARN: No snapshots for market_id=${mid} (${ref}). Observer has not ingested this market yet.`,
        );
        hadWarnings = true;
        continue;
      }
      const latest = row.latest ? new Date(row.latest) : null;
      const total = Number(row.total ?? 0);
      if (!latest || Number.isNaN(latest.getTime())) {
        console.warn(
          `WARN: Invalid latest snapshot timestamp for market_id=${mid} (${ref}).`,
        );
        hadWarnings = true;
        continue;
      }
      const ageSeconds = Math.max(
        0,
        Math.round((nowMs - latest.getTime()) / 1000),
      );
      if (ageSeconds > MAX_LAG_SECONDS) {
        console.warn(
          `WARN: Snapshots for market_id=${mid} are stale (latest: ${latest.toISOString()}). Observer may not be covering this market.`,
        );
        hadWarnings = true;
      } else {
        console.log(
          `✓ market_id=${mid} (${ref}): ${total} snapshots, latest ${latest.toISOString()}`,
        );
      }
    }

    // Step 4: Check family appears in top-divergences via API
    const famRes = await client.query(
      `SELECT mf.canonical_event_id, ce.slug
       FROM pmci.market_families mf
       LEFT JOIN pmci.canonical_events ce ON ce.id = mf.canonical_event_id
       WHERE mf.id = $1`,
      [familyId],
    );
    const famRow = famRes.rows?.[0];
    const canonicalEventId = famRow?.canonical_event_id;

    if (!canonicalEventId) {
      console.warn(
        `WARN: family_id=${familyId} has no canonical_event_id. Cannot query top-divergences by event. Skipping divergence check.`,
      );
      hadWarnings = true;
    } else {
      const url = `${API_BASE}/v1/signals/top-divergences?event_id=${canonicalEventId}&limit=100`;
      let results = null;
      try {
        const resp = await fetch(url);
        results = await resp.json();
      } catch (err) {
        console.warn(
          `WARN: Could not reach API at ${API_BASE}. Is npm run api:pmci running? Skipping divergence check.`,
        );
        hadWarnings = true;
      }

      if (Array.isArray(results)) {
        if (results.length === 0) {
          console.warn(
            `WARN: top-divergences returned 0 results for event_id=${canonicalEventId}.`,
          );
          hadWarnings = true;
        } else {
          const item = results.find(
            (r) => Number(r.family_id) === familyId,
          );
          if (item) {
            console.log(
              `✓ family_id=${familyId} appears in top-divergences (max_divergence=${item.max_divergence ?? "null"})`,
            );
          } else {
            console.warn(
              `WARN: family_id=${familyId} not in top-divergences response (${results.length} families returned for event).\n       This is expected if neither market has a recent snapshot yet.`,
            );
            hadWarnings = true;
          }
        }
      }
    }

    // Step 5: Check re-proposal guard (idempotency)
    const dupRes = await client.query(
      `SELECT COUNT(*)::int AS count
       FROM pmci.proposed_links
       WHERE decision IS NULL
         AND (
           (provider_market_id_a = $1 AND provider_market_id_b = $2)
           OR (provider_market_id_a = $2 AND provider_market_id_b = $1)
         )`,
      [idA, idB],
    );
    const dupCount = Number(dupRes.rows?.[0]?.count ?? 0);
    if (dupCount > 0) {
      console.warn(
        `WARN: ${dupCount} pending proposal(s) still exist for this market pair. The proposer may re-propose already-decided pairs.`,
      );
      hadWarnings = true;
    } else {
      console.log(
        "✓ No duplicate pending proposals for this pair (re-proposal guard is working)",
      );
    }

    // Final summary
    if (hardFail) {
      // already handled above; keep for clarity
      console.log(
        "⚠ Round-trip check failed due to hard error. See items above.",
      );
    } else if (hadWarnings) {
      console.log(
        "⚠ Round-trip check completed with warnings. See items above.",
      );
    } else {
      console.log(
        "✓ Round-trip check passed. Proposal → family → links → snapshots chain is intact.",
      );
    }
  } finally {
    try {
      await client.end();
    } catch {
      // ignore
    }
    if (hardFail) {
      process.exit(1);
    } else {
      process.exit(0);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

