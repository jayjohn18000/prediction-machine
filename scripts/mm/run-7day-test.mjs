#!/usr/bin/env node
/**
 * W6 continuous-quote validation harness — MVP exit criteria (phase-mm-mvp-plan.md).
 *
 * Default sleep: 7 days. Use `--fast` / `--duration=1h` for local validation (no prod wait).
 *
 * Requires DATABASE_URL for exit checks; MM_HEALTH_URL for orchestrator heartbeat (default http://127.0.0.1:8765).
 */
import { createPgClient } from "../../lib/mm/order-store.mjs";

function parseArgs(argv) {
  const out = {
    durationSec: 7 * 24 * 60 * 60,
    mmHealthUrl: process.env.MM_HEALTH_URL?.trim() || "http://127.0.0.1:8765",
    pmciApiUrl: process.env.PMCI_API_URL?.trim() || "http://127.0.0.1:8787",
  };
  for (const a of argv) {
    if (a === "--fast" || a === "--1h") {
      out.durationSec = 60 * 60;
    }
    if (a.startsWith("--duration=")) {
      const v = a.slice("--duration=".length).trim().toLowerCase();
      const m = v.match(/^(\d+)([smhd])$/);
      if (m) {
        const n = Number(m[1]);
        const unit = m[2];
        const mul = unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : 86400;
        out.durationSec = n * mul;
      }
    }
    if (a.startsWith("--mm-health-url=")) {
      out.mmHealthUrl = a.slice("--mm-health-url=".length);
    }
  }
  return out;
}

async function fetchHealth(url, path = "/health/mm") {
  const u = new URL(path, url.replace(/\/$/, ""));
  const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
  const txt = await r.text();
  try {
    return { ok: r.ok, status: r.status, body: JSON.parse(txt) };
  } catch {
    return { ok: r.ok, status: r.status, body: txt };
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL?.trim()) {
    console.error("DATABASE_URL required for exit checks");
    process.exit(1);
  }

  const hh = await fetchHealth(opts.mmHealthUrl);
  if (!hh.ok) {
    console.error("[7day] orchestrator heartbeat failed:", hh.status, hh.body);
    process.exit(2);
  }
  console.log("[7day] MM health:", JSON.stringify(hh.body));

  const client = createPgClient();
  await client.connect();

  const initial = {};
  async function snapshotState() {
    const pos = await client.query(`SELECT count(*)::int AS n FROM pmci.mm_positions WHERE net_contracts <> 0`);
    const fills = await client.query(`SELECT count(*)::int AS n FROM pmci.mm_fills`);
    const snaps = await client.query(`SELECT count(*)::int AS n FROM pmci.mm_pnl_snapshots`);
    return {
      nonzero_positions: pos.rows[0]?.n ?? 0,
      fills_total: fills.rows[0]?.n ?? 0,
      pnl_snapshots_total: snaps.rows[0]?.n ?? 0,
    };
  }

  Object.assign(initial, await snapshotState());
  console.log("[7day] initial snapshot:", initial);

  console.log(`[7day] sleeping ${opts.durationSec}s …`);
  await new Promise((r) => setTimeout(r, opts.durationSec * 1000));

  const cfg = await client.query(`SELECT count(*)::int AS n FROM pmci.mm_market_config WHERE enabled = true`);
  const mktsQuoted = cfg.rows[0]?.n ?? 0;

  const pnlAgg = await client.query(
    `
    SELECT coalesce(sum(net_pnl_cents), 0)::numeric AS total
    FROM pmci.mm_pnl_snapshots
    WHERE observed_at > now() - interval '7 days'
    `,
  );
  const pnlPositive = Number(pnlAgg.rows[0]?.total ?? 0) > 0;

  const ks = await client.query(
    `
    SELECT market_id, count(*)::int AS fires
    FROM pmci.mm_kill_switch_events
    WHERE observed_at > now() - interval '7 days'
      AND coalesce(reason, '') <> 'auto_reset'
    GROUP BY market_id
    `,
  );

  const riskBreaches = await client.query(
    `
    SELECT count(*)::int AS n
    FROM pmci.mm_orders o
    JOIN pmci.mm_market_config c ON c.market_id = o.market_id
    WHERE (o.price_cents::bigint * o.size_contracts::bigint) > c.max_order_notional_cents
    `,
  );

  const advCover = await client.query(
    `
    SELECT
      CASE WHEN count(*) = 0 THEN 0::float
           else (sum(case when adverse_selection_cents is not null then 1 else 0 end)::float / count(*)::float)
      END AS frac
    FROM pmci.mm_pnl_snapshots
    WHERE observed_at > now() - interval '7 days'
    `,
  );

  await client.end();

  /** @type {Array<{ id: string, pass: boolean, detail: string }>} */
  const criteria = [];

  const minMkts = Number(process.env.MM_EXIT_MIN_MARKETS ?? "5");
  criteria.push({
    id: "markets_enabled",
    pass: mktsQuoted >= minMkts,
    detail: `enabled_mm_markets=${mktsQuoted} (min ${minMkts}; set MM_EXIT_MIN_MARKETS for DEMO)`,
  });

  criteria.push({
    id: "net_positive_pnl_snapshots_sum",
    pass: pnlPositive,
    detail: `sum(net_pnl_cents)>0 → ${pnlAgg.rows[0]?.total}`,
  });

  const flattenOk = ks.rows.every((r) => Number(r.fires) <= 1);
  criteria.push({
    id: "auto_flatten_per_market",
    pass: flattenOk,
    detail: JSON.stringify(ks.rows),
  });

  criteria.push({
    id: "no_risk_limit_breaches",
    pass: Number(riskBreaches.rows[0]?.n ?? 0) === 0,
    detail: `breaching_orders=${riskBreaches.rows[0]?.n ?? 0}`,
  });

  const frac = Number(advCover.rows[0]?.frac ?? 0);
  criteria.push({
    id: "pnl_attrib_legibility",
    pass: frac > 0.5,
    detail: `fraction snapshots with adverse_selection_cents NOT NULL=${frac}`,
  });

  for (const c of criteria) {
    console.log(`[7day] ${c.pass ? "PASS" : "FAIL"} — ${c.id}: ${c.detail}`);
  }

  const allOk = criteria.every((c) => c.pass);
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
